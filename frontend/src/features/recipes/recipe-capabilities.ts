import type { FleetRouteCapability, RecipeWithStatus } from "@/lib/types";

const FLEET_ROUTE_CAPABILITIES = new Set<FleetRouteCapability>([
  "chat",
  "embeddings",
  "vision",
  "audio",
]);

const metadataForRecipe = (recipe: RecipeWithStatus): Record<string, unknown> => {
  const metadata = recipe.extra_args?.["metadata"];
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
};

export const isFleetRouteRecipe = (recipe: RecipeWithStatus): boolean =>
  metadataForRecipe(recipe)["virtual_recipe"] === true || recipe.id.startsWith("fleet-route-");

export const recipeCapabilities = (recipe: RecipeWithStatus): FleetRouteCapability[] => {
  const raw = metadataForRecipe(recipe)["fleet_capabilities"];
  if (Array.isArray(raw)) {
    const normalized = Array.from(
      new Set(
        raw.filter(
          (entry): entry is FleetRouteCapability =>
            typeof entry === "string" &&
            FLEET_ROUTE_CAPABILITIES.has(entry as FleetRouteCapability),
        ),
      ),
    ).sort();
    if (normalized.length) return normalized;
  }
  return ["chat"];
};

export const recipeSupportsCapability = (
  recipe: RecipeWithStatus,
  capability: FleetRouteCapability,
): boolean => {
  if (!isFleetRouteRecipe(recipe)) return capability === "chat";
  const capabilities = recipeCapabilities(recipe);
  if (capability === "chat")
    return capabilities.includes("chat") || capabilities.includes("vision");
  return capabilities.includes(capability);
};
