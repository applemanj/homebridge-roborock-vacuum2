import { PlatformConfig } from "homebridge";

export interface RoborockPlatformConfig extends PlatformConfig {
  email: string;
  password?: string;
  debugMode: boolean;
  baseURL?: string;
  encryptedToken?: string;
  skipDevices?: string;
  transientWarningThrottleHours?: number;
  enableMatter?: boolean;
  enableMatterServiceArea?: boolean;
  enableMatterPowerSource?: boolean;
  enableMatterCleanMode?: boolean;
  enableMatterExtendedOperationalStates?: boolean;
  /**
   * When true and Matter is available, the plugin will only expose the Matter-native
   * robotic vacuum accessory and will not register the legacy HomeKit fan + switch
   * accessories. Useful for users who prefer the Matter representation only.
   */
  /**
   * When true, hide only the legacy HomeKit Fan service while continuing to
   * expose the other legacy HomeKit switches and the Matter vacuum.
   */
  hideOnlyLegacyFanService?: boolean;

  onlyExposeMatter?: boolean;
  cloudOnlyMode?: boolean;
  preferCloudForMatterCommands?: boolean;
}
