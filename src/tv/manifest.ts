/**
 * Manifiesto de emparejamiento LG Connect.
 *
 * SIN firma: la firma test-signing-cert de LG (appId com.lge.test, serial
 * 2f930e2d...) que los clientes open source copiaban de bscpylgtv esta en la
 * blacklist de LG en firmwares recientes (CVE-2023-6317; observado en 43.x,
 * depende de modelo/firmware): la tele rechaza el pairing con 403
 * "blacklisted certificate detected". Este es el fix oficial
 * de aiowebostv >= 0.9.2: manifiesto sin firmar con TODOS los permisos en el
 * array `permissions` externo. Verificado contra la tele real (pairing, toast
 * y launch OK, 11 oct 2026).
 *
 * Consecuencia documentada: sin firma la tele puede NO conceder WRITE_SETTINGS
 * ni READ_UPDATE_INFO (depende de modelo/firmware). Para
 * ajustes de imagen haria falta el truco createAlert onClick/onfail ->
 * luna://com.webos.settingsservice/setSystemSettings, o el puerto 9761
 * (IP Control). Decidido por main bajo preferencias de Nico (cero terminal /
 * secretos fuera de chat).
 */
export const TV_MANIFEST = {
  appVersion: '1.1',
  manifestVersion: 1,
  deviceName: 'asistenta',
  permissions: [
    'LAUNCH',
    'LAUNCH_WEBAPP',
    'APP_TO_APP',
    'CLOSE',
    'TEST_OPEN',
    'TEST_PROTECTED',
    'TEST_SECURE',
    'CONTROL_AUDIO',
    'CONTROL_DISPLAY',
    'CONTROL_INPUT_JOYSTICK',
    'CONTROL_INPUT_MEDIA_RECORDING',
    'CONTROL_INPUT_MEDIA_PLAYBACK',
    'CONTROL_INPUT_TV',
    'CONTROL_INPUT_TEXT',
    'CONTROL_MOUSE_AND_KEYBOARD',
    'CONTROL_POWER',
    'CONTROL_TV_SCREEN',
    'READ_APP_STATUS',
    'READ_CURRENT_CHANNEL',
    'READ_COUNTRY_INFO',
    'READ_INPUT_DEVICE_LIST',
    'READ_INSTALLED_APPS',
    'READ_LGE_SDX',
    'READ_LGE_TV_INPUT_EVENTS',
    'READ_NETWORK_STATE',
    'READ_NOTIFICATIONS',
    'READ_POWER_STATE',
    'READ_RUNNING_APPS',
    'READ_SETTINGS',
    'READ_STORAGE_DEVICE_LIST',
    'READ_TV_CHANNEL_LIST',
    'READ_TV_CURRENT_TIME',
    'READ_UPDATE_INFO',
    'SEARCH',
    'UPDATE_FROM_REMOTE_APP',
    'WRITE_NOTIFICATION_ALERT',
    'WRITE_NOTIFICATION_TOAST',
    'WRITE_SETTINGS',
  ],
} as const;
