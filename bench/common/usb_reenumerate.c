// Re-enumerate the ESP32-S3 USB-Serial/JTAG device: a software unplug and replug.
// The M5StickS3 USB port occasionally stops responding after a reset; this recovers it without touching the cable.
// Written by a pi agent during a benchmark run (see bench/README.md).
#include <stdio.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>

int main(void) {
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
        if (vendor == 12346 && product == 4097) {
            found = 1;
            printf("Found ESP32 USB JTAG (vid=%d pid=%d)\n", vendor, product);
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
