PRAGMA foreign_keys = ON;

CREATE TABLE "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "emailVerified" integer DEFAULT 0 NOT NULL,
  "image" text,
  "ownerKey" text NOT NULL,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL
);

CREATE UNIQUE INDEX "user_email_unique" ON "user" ("email");
CREATE UNIQUE INDEX "user_ownerKey_unique" ON "user" ("ownerKey");

CREATE TABLE "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expiresAt" integer NOT NULL,
  "token" text NOT NULL,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL,
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE UNIQUE INDEX "session_token_unique" ON "session" ("token");
CREATE INDEX "session_userId_idx" ON "session" ("userId");

CREATE TABLE "account" (
  "id" text PRIMARY KEY NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" integer,
  "refreshTokenExpiresAt" integer,
  "scope" text,
  "password" text,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL,
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE UNIQUE INDEX "account_provider_account_idx" ON "account" ("providerId", "accountId");

CREATE TABLE "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" integer NOT NULL,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL
);

CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE "jwks" (
  "id" text PRIMARY KEY NOT NULL,
  "publicKey" text NOT NULL,
  "privateKey" text NOT NULL,
  "createdAt" integer NOT NULL,
  "expiresAt" integer,
  "alg" text,
  "crv" text
);

CREATE TABLE "oauthClient" (
  "id" text PRIMARY KEY NOT NULL,
  "clientId" text NOT NULL,
  "clientSecret" text,
  "disabled" integer DEFAULT 0,
  "skipConsent" integer,
  "enableEndSession" integer,
  "subjectType" text,
  "scopes" text,
  "userId" text,
  "createdAt" integer,
  "updatedAt" integer,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" text,
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" text NOT NULL,
  "postLogoutRedirectUris" text,
  "backchannelLogoutUri" text,
  "backchannelLogoutSessionRequired" integer,
  "tokenEndpointAuthMethod" text,
  "jwks" text,
  "jwksUri" text,
  "grantTypes" text,
  "responseTypes" text,
  "public" integer,
  "type" text,
  "requirePKCE" integer,
  "dpopBoundAccessTokens" integer DEFAULT 0,
  "referenceId" text,
  "metadata" text,
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE UNIQUE INDEX "oauthClient_clientId_unique" ON "oauthClient" ("clientId");
CREATE INDEX "oauthClient_userId_idx" ON "oauthClient" ("userId");

CREATE TABLE "oauthResource" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "name" text NOT NULL,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" text,
  "customClaims" text,
  "dpopBoundAccessTokensRequired" integer DEFAULT 0,
  "disabled" integer DEFAULT 0,
  "createdAt" integer,
  "updatedAt" integer,
  "policyVersion" integer DEFAULT 1,
  "metadata" text
);

CREATE UNIQUE INDEX "oauthResource_identifier_unique" ON "oauthResource" ("identifier");

CREATE TABLE "oauthClientResource" (
  "id" text PRIMARY KEY NOT NULL,
  "clientId" text NOT NULL,
  "resourceId" text NOT NULL,
  "metadata" text,
  "createdAt" integer,
  FOREIGN KEY ("clientId") REFERENCES "oauthClient" ("clientId") ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY ("resourceId") REFERENCES "oauthResource" ("identifier") ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE INDEX "oauthClientResource_clientId_idx" ON "oauthClientResource" ("clientId");
CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauthClientResource" ("resourceId");

CREATE TABLE "oauthRefreshToken" (
  "id" text PRIMARY KEY NOT NULL,
  "token" text NOT NULL,
  "clientId" text NOT NULL,
  "sessionId" text,
  "userId" text NOT NULL,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" text,
  "requestedUserInfoClaims" text,
  "expiresAt" integer NOT NULL,
  "createdAt" integer NOT NULL,
  "revoked" integer,
  "rotatedAt" integer,
  "rotationReplayResponse" text,
  "rotationReplayExpiresAt" integer,
  "authTime" integer,
  "confirmation" text,
  "scopes" text NOT NULL,
  FOREIGN KEY ("clientId") REFERENCES "oauthClient" ("clientId") ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY ("sessionId") REFERENCES "session" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE UNIQUE INDEX "oauthRefreshToken_token_unique" ON "oauthRefreshToken" ("token");
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx"
  ON "oauthRefreshToken" ("authorizationCodeId");
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken" ("clientId");
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken" ("sessionId");
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauthRefreshToken" ("userId");

CREATE TABLE "oauthAccessToken" (
  "id" text PRIMARY KEY NOT NULL,
  "token" text NOT NULL,
  "clientId" text NOT NULL,
  "sessionId" text,
  "userId" text,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" text,
  "requestedUserInfoClaims" text,
  "refreshId" text,
  "expiresAt" integer NOT NULL,
  "createdAt" integer NOT NULL,
  "revoked" integer,
  "confirmation" text,
  "scopes" text NOT NULL,
  FOREIGN KEY ("clientId") REFERENCES "oauthClient" ("clientId") ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY ("sessionId") REFERENCES "session" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY ("refreshId") REFERENCES "oauthRefreshToken" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE UNIQUE INDEX "oauthAccessToken_token_unique" ON "oauthAccessToken" ("token");
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx"
  ON "oauthAccessToken" ("authorizationCodeId");
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauthAccessToken" ("sessionId");
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauthAccessToken" ("refreshId");

CREATE TABLE "oauthConsent" (
  "id" text PRIMARY KEY NOT NULL,
  "clientId" text NOT NULL,
  "userId" text,
  "referenceId" text,
  "resources" text,
  "requestedUserInfoClaims" text,
  "scopes" text NOT NULL,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL,
  FOREIGN KEY ("clientId") REFERENCES "oauthClient" ("clientId") ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");
CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent" ("userId");

CREATE TABLE "oauthClientAssertion" (
  "id" text PRIMARY KEY NOT NULL,
  "expiresAt" integer NOT NULL
);

CREATE TABLE "mcpClientRegistration" (
  "clientId" text PRIMARY KEY NOT NULL,
  "expiresAt" integer NOT NULL,
  "createdAt" integer NOT NULL,
  FOREIGN KEY ("clientId") REFERENCES "oauthClient" ("clientId") ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE INDEX "mcpClientRegistration_expiresAt_idx"
  ON "mcpClientRegistration" ("expiresAt");

CREATE TABLE "mcpTokenRevocation" (
  "tokenHash" text PRIMARY KEY NOT NULL,
  "expiresAt" integer NOT NULL,
  "createdAt" integer NOT NULL
);

CREATE INDEX "mcpTokenRevocation_expiresAt_idx"
  ON "mcpTokenRevocation" ("expiresAt");
