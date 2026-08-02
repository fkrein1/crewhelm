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
import migration12 from "./0012_acoustic_killraven.sql";
import migration13 from "./0013_scale_fleet_configuration.sql";
import migration14 from "./0014_closed_patriot.sql";
import migration15 from "./0015_simple_thaddeus_ross.sql";
import migration16 from "./0016_skinny_rattler.sql";
import migration17 from "./0017_messy_argent.sql";
import migration18 from "./0018_clear_franklin_richards.sql";
import migration19 from "./0019_dashing_dragon_lord.sql";
import migration20 from "./0020_expand_inference_profiles.sql";
import migration21 from "./0021_futuristic_adam_destine.sql";
import migration22 from "./0022_adorable_marrow.sql";
import migration23 from "./0023_abnormal_sister_grimm.sql";
import migration24 from "./0024_broad_micromacro.sql";
import migration25 from "./0025_charming_squadron_supreme.sql";
import migration26 from "./0026_fresh_white_queen.sql";
import migration27 from "./0027_classy_switch.sql";
import migration28 from "./0028_purple_impossible_man.sql";
import migration29 from "./0029_mushy_legion.sql";
import migration30 from "./0030_mixed_corsair.sql";
import migration31 from "./0031_freezing_master_chief.sql";
import migration32 from "./0032_panoramic_speed_demon.sql";

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
  {
    name: "0012_acoustic_killraven",
    sql: migration12,
    version: 13,
  },
  {
    name: "0013_scale_fleet_configuration",
    sql: migration13,
    version: 14,
  },
  {
    name: "0014_closed_patriot",
    sql: migration14,
    version: 15,
  },
  {
    name: "0015_simple_thaddeus_ross",
    sql: migration15,
    version: 16,
  },
  {
    name: "0016_skinny_rattler",
    sql: migration16,
    version: 17,
  },
  {
    name: "0017_messy_argent",
    sql: migration17,
    version: 18,
  },
  {
    name: "0018_clear_franklin_richards",
    sql: migration18,
    version: 19,
  },
  {
    name: "0019_dashing_dragon_lord",
    sql: migration19,
    version: 20,
  },
  {
    name: "0020_expand_inference_profiles",
    sql: migration20,
    version: 21,
  },
  {
    name: "0021_futuristic_adam_destine",
    sql: migration21,
    version: 22,
  },
  {
    name: "0022_adorable_marrow",
    sql: migration22,
    version: 23,
  },
  {
    name: "0023_abnormal_sister_grimm",
    sql: migration23,
    version: 24,
  },
  {
    name: "0024_broad_micromacro",
    sql: migration24,
    version: 25,
  },
  {
    name: "0025_charming_squadron_supreme",
    sql: migration25,
    version: 26,
  },
  {
    name: "0026_fresh_white_queen",
    sql: migration26,
    version: 27,
  },
  {
    name: "0027_classy_switch",
    sql: migration27,
    version: 28,
  },
  {
    name: "0028_purple_impossible_man",
    sql: migration28,
    version: 29,
  },
  {
    name: "0029_mushy_legion",
    sql: migration29,
    version: 30,
  },
  {
    name: "0030_mixed_corsair",
    sql: migration30,
    version: 31,
  },
  {
    name: "0031_freezing_master_chief",
    sql: migration31,
    version: 32,
  },
  {
    name: "0032_panoramic_speed_demon",
    sql: migration32,
    version: 33,
  },
] as const;

export const CONTROL_PLANE_SCHEMA_VERSION = controlPlaneMigrations.length;
