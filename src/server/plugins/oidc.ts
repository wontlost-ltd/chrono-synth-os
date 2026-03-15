export interface OidcClientConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  audience?: string;
  scope?: string;
}

export interface OidcProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
}

const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000;
const discoveryCache = new Map<string, { expiresAt: number; metadata: OidcProviderMetadata }>();

function getDiscoveryUrl(issuerUrl: string): string {
  return new URL('/.well-known/openid-configuration', issuerUrl.endsWith('/') ? issuerUrl : `${issuerUrl}/`).toString();
}

export async function discoverOidcConfiguration(issuerUrl: string): Promise<OidcProviderMetadata> {
  const cached = discoveryCache.get(issuerUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.metadata;
  }

  const response = await fetch(getDiscoveryUrl(issuerUrl));
  if (!response.ok) {
    throw new Error(`OIDC discovery 失败: ${response.status}`);
  }

  const metadata = await response.json() as OidcProviderMetadata;
  discoveryCache.set(issuerUrl, {
    expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS,
    metadata,
  });
  return metadata;
}

export async function buildOidcAuthorizeUrl(
  config: OidcClientConfig,
  redirectUri: string,
  state: string,
): Promise<string> {
  const metadata = await discoverOidcConfiguration(config.issuerUrl);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scope || 'openid profile email',
    state,
  });
  if (config.audience) {
    params.set('audience', config.audience);
  }
  return `${metadata.authorization_endpoint}?${params.toString()}`;
}

export async function exchangeOidcCode(
  config: OidcClientConfig,
  code: string,
  redirectUri: string,
): Promise<{
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
}> {
  const metadata = await discoverOidcConfiguration(config.issuerUrl);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
  });

  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OIDC token 交换失败: ${response.status} ${text}`);
  }

  return response.json() as Promise<{
    access_token: string;
    id_token?: string;
    token_type: string;
    expires_in?: number;
  }>;
}

export async function fetchOidcUserInfo(
  config: OidcClientConfig,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const metadata = await discoverOidcConfiguration(config.issuerUrl);
  if (!metadata.userinfo_endpoint) {
    throw new Error('OIDC provider 未提供 userinfo_endpoint');
  }

  const response = await fetch(metadata.userinfo_endpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`OIDC userinfo 获取失败: ${response.status}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

