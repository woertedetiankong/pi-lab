// Re-enumerate the ESP32-S3 USB-Serial/JTAG device: a software unplug and replug.
// The M5StickS3 USB port occasionally stops responding after a reset; this recovers it without touching the cable.
// Written by a pi agent during a pi-lab benchmark run. Usage: usb_reenumerate [vendor-id] (default 0x303a, Espressif)
#include <stdio.h>
#include <stdlib.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>

int main(int argc, char **argv) {
    long want_vendor = argc > 1 ? strtol(argv[1], NULL, 0) : 0x303a;
    io_iterator_t iter;
    kern_return_t kr = IOServiceGetMatchingServices(kIOMainPortDefault,
        IOServiceMatching(kIOUSBDeviceClassName), &iter);
    if (kr != kIOReturnSuccess) { printf("match failed %x\n", kr); return 1; }
    io_service_t device;
    int found = 0;
    while ((device = IOIteratorNext(iter))) {
        IOCFPlugInInterface **plugin = NULL;
        SInt32 score;
        kr = IOCreatePlugInInterfaceForService(device, kIOUSBDeviceUserClientTypeID,
            kIOCFPlugInInterfaceID, &plugin, &score);
        if (kr != kIOReturnSuccess || plugin == NULL) { IOObjectRelease(device); continue; }
        IOUSBDeviceInterface **dev = NULL;
        (*plugin)->QueryInterface(plugin, CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID),
            (LPVOID*)&dev);
        (*plugin)->Release(plugin);
        if (dev == NULL) { IOObjectRelease(device); continue; }
        UInt16 vendor = 0, product = 0;
        (*dev)->GetDeviceVendor(dev, &vendor);
        (*dev)->GetDeviceProduct(dev, &product);
        if (vendor == want_vendor) {
            found = 1;
            printf("Found USB device %04x:%04x\n", vendor, product);
            IOReturn r = (*dev)->USBDeviceOpen(dev);
            printf("open -> %x\n", r);
            r = (*dev)->USBDeviceReEnumerate(dev, 0);
            printf("re-enumerate -> %x\n", r);
            if (r == kIOReturnSuccess) (*dev)->USBDeviceClose(dev);
        }
        (*dev)->Release(dev);
        IOObjectRelease(device);
    }
    IOObjectRelease(iter);
    if (!found) printf("device not found\n");
    return 0;
}
