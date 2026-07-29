import migration0 from "./0000_wooden_newton_destine.sql";
import migration1 from "./0001_windy_bushwacker.sql";
import migration2 from "./0002_cool_rictor.sql";
import migration3 from "./0003_windy_stepford_cuckoos.sql";
import migration4 from "./0004_eminent_mongoose.sql";
import migration5 from "./0005_young_norman_osborn.sql";
import migration6 from "./0006_concerned_mesmero.sql";
import migration7 from "./0007_pale_spencer_smythe.sql";
import migration8 from "./0008_backfill_tool_authorization.sql";
import migration9 from "./0009_colorful_skullbuster.sql";
import migration10 from "./0010_famous_george_stacy.sql";
import migration11 from "./0011_remove_fleet_ai_budget.sql";

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
  {
    name: "0002_cool_rictor",
    sql: migration2,
    version: 3,
  },
  {
    name: "0003_windy_stepford_cuckoos",
    sql: migration3,
    version: 4,
  },
  {
    name: "0004_eminent_mongoose",
    sql: migration4,
    version: 5,
  },
  {
    name: "0005_young_norman_osborn",
    sql: migration5,
    version: 6,
  },
  {
    name: "0006_concerned_mesmero",
    sql: migration6,
    version: 7,
  },
  {
    name: "0007_pale_spencer_smythe",
    sql: migration7,
    version: 8,
  },
  {
    name: "0008_backfill_tool_authorization",
    sql: migration8,
    version: 9,
  },
  {
    name: "0009_colorful_skullbuster",
    sql: migration9,
    version: 10,
  },
  {
    name: "0010_famous_george_stacy",
    sql: migration10,
    version: 11,
  },
  {
    name: "0011_remove_fleet_ai_budget",
    sql: migration11,
    version: 12,
  },
] as const;

export const CONTROL_PLANE_SCHEMA_VERSION = controlPlaneMigrations.length;
