import migration0 from "./0000_wooden_newton_destine.sql";
import migration1 from "./0001_windy_bushwacker.sql";

export const controlPlaneMigrations = [
  {
    name: "0000_wooden_newton_destine",
    sql: migration0,
    version: 1,
  },
  {
    name: "0001_windy_bushwacker",
    sql: migration1,
    version: 2,
  },
] as const;

export const CONTROL_PLANE_SCHEMA_VERSION = controlPlaneMigrations.length;
