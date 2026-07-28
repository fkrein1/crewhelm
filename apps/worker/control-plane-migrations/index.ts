import migration0 from "./0000_wooden_newton_destine.sql";
import migration1 from "./0001_windy_bushwacker.sql";
import migration2 from "./0002_cool_rictor.sql";
import migration3 from "./0003_windy_stepford_cuckoos.sql";
import migration4 from "./0004_eminent_mongoose.sql";
import migration5 from "./0005_young_norman_osborn.sql";

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
] as const;

export const CONTROL_PLANE_SCHEMA_VERSION = controlPlaneMigrations.length;
