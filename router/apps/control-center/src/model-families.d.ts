import type { RouterModel } from "./types";

export interface ModelFamily {
  id: string;
  displayName: string;
  routes: RouterModel[];
}

export function modelFamilyName(model: RouterModel): string;
export function modelFamilyKey(model: Pick<RouterModel, "slug" | "displayName">): string;
export function groupModelFamilies(models: RouterModel[]): ModelFamily[];
export function preferredFamilyRoute(family: ModelFamily): RouterModel;
