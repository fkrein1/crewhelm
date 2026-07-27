import migration0 from "./0000_wooden_newton_destine.sql";

export const controlPlaneMigrations = [
  {
    name: "0000_wooden_newton_destine",
    sql: migration0,
    version: 1,
  },
] as const;

export const CONTROL_PLANE_SCHEMA_VERSION = controlPlaneMigrations.length;
