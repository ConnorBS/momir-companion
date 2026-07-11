/**
 * Application Constants (trimmed vendored copy — see NOTICE.md)
 * Source: https://github.com/transcriptionstream/phomymo (src/web/constants.js)
 * Only the sections imported by ble.js / printer.js are retained.
 */

// =============================================================================
// BLE TRANSPORT
// =============================================================================
export const BLE = {
  SERVICE_UUID: 0xff00,
  WRITE_CHAR_UUID: 0xff02,
  NOTIFY_CHAR_UUID: 0xff03,
  // Alternative service UUIDs for different printer models (PM-241, etc.)
  ALT_SERVICE_UUIDS: [
    0xff00,           // Standard Phomemo
    0xffe0,           // Common thermal printer service
    0xae30,           // Some label printers
    '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISS (Issc) service
    '0000ff00-0000-1000-8000-00805f9b34fb', // Full UUID variant
  ],
  CHUNK_SIZE: 128,
  CHUNK_DELAY_MS: 20,
  MAX_RETRIES: 1,
  INITIAL_RETRY_DELAY_MS: 300,
};

// =============================================================================
// STORAGE KEYS
// =============================================================================
export const STORAGE_KEYS = {
  DEVICE_MAPPING: 'phomymo_device_models',
  DESIGNS: 'phomymo_designs',
  SETTINGS: 'phomymo_settings',
  MULTI_LABEL_PRESETS: 'phomymo_multi_label_presets',
  LOCAL_FONTS_ENABLED: 'phomymo_local_fonts_enabled',
  CUSTOM_PRINTERS: 'phomymo_custom_printers',
};
