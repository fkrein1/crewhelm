import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  ownerKey: text("ownerKey").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("account_userId_idx").on(table.userId),
    uniqueIndex("account_provider_account_idx").on(table.providerId, table.accountId),
  ],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClient = sqliteTable(
  "oauthClient",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId").notNull().unique(),
    clientSecret: text("clientSecret"),
    disabled: integer("disabled", { mode: "boolean" }).default(false),
    skipConsent: integer("skipConsent", { mode: "boolean" }),
    enableEndSession: integer("enableEndSession", { mode: "boolean" }),
    subjectType: text("subjectType"),
    scopes: text("scopes", { mode: "json" }).$type<string[]>(),
    userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("createdAt", { mode: "timestamp" }),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts", { mode: "json" }).$type<string[]>(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("softwareId"),
    softwareVersion: text("softwareVersion"),
    softwareStatement: text("softwareStatement"),
    redirectUris: text("redirectUris", { mode: "json" }).$type<string[]>().notNull(),
    postLogoutRedirectUris: text("postLogoutRedirectUris", { mode: "json" }).$type<string[]>(),
    backchannelLogoutUri: text("backchannelLogoutUri"),
    backchannelLogoutSessionRequired: integer("backchannelLogoutSessionRequired", {
      mode: "boolean",
    }),
    tokenEndpointAuthMethod: text("tokenEndpointAuthMethod"),
    jwks: text("jwks"),
    jwksUri: text("jwksUri"),
    grantTypes: text("grantTypes", { mode: "json" }).$type<string[]>(),
    responseTypes: text("responseTypes", { mode: "json" }).$type<string[]>(),
    public: integer("public", { mode: "boolean" }),
    type: text("type"),
    requirePKCE: integer("requirePKCE", { mode: "boolean" }),
    dpopBoundAccessTokens: integer("dpopBoundAccessTokens", { mode: "boolean" }).default(false),
    referenceId: text("referenceId"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [index("oauthClient_userId_idx").on(table.userId)],
);

export const oauthResource = sqliteTable("oauthResource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("accessTokenTtl"),
  refreshTokenTtl: integer("refreshTokenTtl"),
  signingAlgorithm: text("signingAlgorithm"),
  signingKeyId: text("signingKeyId"),
  allowedScopes: text("allowedScopes", { mode: "json" }).$type<string[]>(),
  customClaims: text("customClaims", { mode: "json" }).$type<Record<string, unknown>>(),
  dpopBoundAccessTokensRequired: integer("dpopBoundAccessTokensRequired", {
    mode: "boolean",
  }).default(false),
  disabled: integer("disabled", { mode: "boolean" }).default(false),
  createdAt: integer("createdAt", { mode: "timestamp" }),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
  policyVersion: integer("policyVersion").default(1),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
});

export const oauthClientResource = sqliteTable(
  "oauthClientResource",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resourceId")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("createdAt", { mode: "timestamp" }),
  },
  (table) => [
    index("oauthClientResource_clientId_idx").on(table.clientId),
    index("oauthClientResource_resourceId_idx").on(table.resourceId),
  ],
);

export const oauthRefreshToken = sqliteTable(
  "oauthRefreshToken",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("sessionId").references(() => session.id, { onDelete: "set null" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: text("resources", { mode: "json" }).$type<string[]>(),
    requestedUserInfoClaims: text("requestedUserInfoClaims", { mode: "json" }).$type<string[]>(),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    revoked: integer("revoked", { mode: "timestamp" }),
    rotatedAt: integer("rotatedAt", { mode: "timestamp" }),
    rotationReplayResponse: text("rotationReplayResponse"),
    rotationReplayExpiresAt: integer("rotationReplayExpiresAt", { mode: "timestamp" }),
    authTime: integer("authTime", { mode: "timestamp" }),
    confirmation: text("confirmation", { mode: "json" }).$type<Record<string, unknown>>(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  },
  (table) => [
    index("oauthRefreshToken_authorizationCodeId_idx").on(table.authorizationCodeId),
    index("oauthRefreshToken_clientId_idx").on(table.clientId),
    index("oauthRefreshToken_sessionId_idx").on(table.sessionId),
    index("oauthRefreshToken_userId_idx").on(table.userId),
  ],
);

export const oauthAccessToken = sqliteTable(
  "oauthAccessToken",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("sessionId").references(() => session.id, { onDelete: "set null" }),
    userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: text("resources", { mode: "json" }).$type<string[]>(),
    requestedUserInfoClaims: text("requestedUserInfoClaims", { mode: "json" }).$type<string[]>(),
    refreshId: text("refreshId").references(() => oauthRefreshToken.id, {
      onDelete: "cascade",
    }),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    revoked: integer("revoked", { mode: "timestamp" }),
    confirmation: text("confirmation", { mode: "json" }).$type<Record<string, unknown>>(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  },
  (table) => [
    index("oauthAccessToken_authorizationCodeId_idx").on(table.authorizationCodeId),
    index("oauthAccessToken_clientId_idx").on(table.clientId),
    index("oauthAccessToken_sessionId_idx").on(table.sessionId),
    index("oauthAccessToken_userId_idx").on(table.userId),
    index("oauthAccessToken_refreshId_idx").on(table.refreshId),
  ],
);

export const oauthConsent = sqliteTable(
  "oauthConsent",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("referenceId"),
    resources: text("resources", { mode: "json" }).$type<string[]>(),
    requestedUserInfoClaims: text("requestedUserInfoClaims", { mode: "json" }).$type<string[]>(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("oauthConsent_clientId_idx").on(table.clientId),
    index("oauthConsent_userId_idx").on(table.userId),
  ],
);

export const oauthClientAssertion = sqliteTable("oauthClientAssertion", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
});

export const mcpClientRegistration = sqliteTable(
  "mcpClientRegistration",
  {
    clientId: text("clientId")
      .primaryKey()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("mcpClientRegistration_expiresAt_idx").on(table.expiresAt)],
);

export const mcpTokenRevocation = sqliteTable(
  "mcpTokenRevocation",
  {
    tokenHash: text("tokenHash").primaryKey(),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("mcpTokenRevocation_expiresAt_idx").on(table.expiresAt)],
);

export const authSchema = {
  account,
  jwks,
  mcpClientRegistration,
  mcpTokenRevocation,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  session,
  user,
  verification,
};
