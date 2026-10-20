export const DEFAULT_OAUTH_LOGIN_METHOD = "browser" as const;

export const OAUTH_LOGIN_METHODS = [DEFAULT_OAUTH_LOGIN_METHOD] as const;

export type OAuthLoginMethod = (typeof OAUTH_LOGIN_METHODS)[number];

export interface OAuthStartRequest {
  provider: string;
  loginMethod?: OAuthLoginMethod;
}

export function isOAuthLoginMethod(value: unknown): value is OAuthLoginMethod {
  return OAUTH_LOGIN_METHODS.includes(value as OAuthLoginMethod);
}
