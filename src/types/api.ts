/**
 * API response envelope — matches the signalk-backup-server contract
 * ({ success, data, error, timestamp }) so the plugin's proxy and the
 * webapp can share one response shape across the container family.
 */

/** Standard API response wrapper */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
  timestamp: string;
}

/** API error details */
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
