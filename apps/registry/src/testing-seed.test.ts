import { describe, expect, it } from "vitest";

import { recipeRegistryOriginSchema, registryPublishBundleSchema } from "@crewhelm/contracts";

import {
  TESTING_SEED_ARTIFACT_VERSION,
  TESTING_SEED_NAMESPACE,
  testingSeedBundles,
} from "./testing-seed.js";

describe("testing Registry seed", () => {
  it("builds ten valid, distinct Recipe bundles pinned to loopback Skills", async () => {
    const origin = "http://127.0.0.1:8788/";
    const bundles = await testingSeedBundles(origin);
    const repeatedBundles = await testingSeedBundles(origin);

    expect(recipeRegistryOriginSchema.parse(origin)).toBe(origin);
    expect(repeatedBundles).toEqual(bundles);
    expect(bundles).toHaveLength(TESTING_SEED_ARTIFACT_VERSION * 10);
    const currentBundles = bundles.filter(
      ({ recipe }) => recipe.version === TESTING_SEED_ARTIFACT_VERSION,
    );
    expect(currentBundles).toHaveLength(10);
    expect(new Set(currentBundles.map(({ recipe }) => recipe.package.name)).size).toBe(10);
    expect(new Set(bundles.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(bundles.length);
    expect(
      currentBundles.some(({ recipe }) => recipe.package.operations.schedules.length > 0),
    ).toBe(true);
    expect(
      currentBundles.some(({ recipe }) => recipe.package.operations.eventTriggers.length > 0),
    ).toBe(true);
    expect(currentBundles.some(({ recipe }) => recipe.package.connections.length > 0)).toBe(true);
    expect(
      currentBundles.some(({ recipe }) =>
        recipe.package.skills.some(({ requirement }) => requirement === "optional"),
      ),
    ).toBe(true);

    for (const bundle of bundles) {
      expect(registryPublishBundleSchema.parse(bundle)).toEqual(bundle);
      expect(bundle.namespace).toBe(TESTING_SEED_NAMESPACE);
      expect(bundle.recipe.package.skills).toHaveLength(1);
      expect(bundle.recipe.package.skills[0]?.registry).toBe(origin);
      expect(bundle.recipe.package.skills[0]?.version).toBe(bundle.recipe.version);
      expect(bundle.skills).toHaveLength(1);
      expect(bundle.skills[0]?.version).toBe(bundle.recipe.version);
    }
  });
});
