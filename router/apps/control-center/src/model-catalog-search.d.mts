import type { ProviderCatalog, ProviderSetup, RouterModel } from "./types";

export interface CatalogSearchDirectoryEntry {
  id: string;
  displayName: string;
  setup?: Pick<ProviderSetup, "catalogSources" | "configured">;
}

export interface CatalogSearchState {
  data?: ProviderCatalog;
}

export interface LoadedCatalogModel {
  key: string;
  modelId: string;
  displayName: string;
  providerId: string;
  providerName: string;
  sourceId: string;
  sourceName: string;
  registered: boolean;
  addable: boolean;
  blockedReason?: string;
  contextWindow?: number;
  isFree: boolean;
}

export type PendingCatalogModels = Record<string, Record<string, number>>;

export function catalogModelName(modelId: string): string;
export function loadedCatalogModels(
  directory: CatalogSearchDirectoryEntry[],
  catalogStates: Record<string, CatalogSearchState>,
): LoadedCatalogModel[];
export function searchLoadedCatalogModels(
  directory: CatalogSearchDirectoryEntry[],
  catalogStates: Record<string, CatalogSearchState>,
  query: string,
): LoadedCatalogModel[];
export function clearProviderCatalogStates<T>(
  current: Record<string, T>,
  catalogSources?: ReadonlyArray<{ id: string }>,
): Record<string, T>;
export function beginCatalogRequest(
  generations: Record<string, number>,
  sourceId: string,
): number;
export function invalidateProviderCatalogRequests(
  generations: Record<string, number>,
  catalogSources?: ReadonlyArray<{ id: string }>,
): void;
export function catalogRequestIsCurrent(
  generations: Record<string, number>,
  sourceId: string,
  generation: number,
): boolean;
export function addPendingCatalogModels(
  current: PendingCatalogModels,
  providerId: string,
  modelIds: string[],
): PendingCatalogModels;
export function removePendingCatalogModels(
  current: PendingCatalogModels,
  providerId: string,
  modelIds: string[],
): PendingCatalogModels;
export function pendingCatalogModelIds(
  current: PendingCatalogModels,
  providerId: string,
): string[];
export function modelRouteProviderId(model: Pick<RouterModel, "slug">): string;
export function modelRouteProtocol(model: Pick<RouterModel, "slug">): "messages" | "responses" | "default";
export function modelRouteKind(model: Pick<RouterModel, "slug" | "native" | "isFree">): string;
