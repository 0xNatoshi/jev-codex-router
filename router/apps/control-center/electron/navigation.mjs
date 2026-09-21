export const NAVIGATION_ARGUMENT = "--router-destination";
export const NAVIGATION_SOURCE_ARGUMENT = "--router-source";
export const NAVIGATION_DESTINATIONS = Object.freeze(["usage", "usage-resets"]);
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function controlCenterDestination(commandLine) {
  if (!Array.isArray(commandLine)) return undefined;
  const destinations = [];
  const sources = [];
  for (let index = 0; index < commandLine.length; index += 1) {
    if (commandLine[index] === NAVIGATION_ARGUMENT) {
      destinations.push(commandLine[index + 1]);
      index += 1;
    } else if (commandLine[index] === NAVIGATION_SOURCE_ARGUMENT) {
      sources.push(commandLine[index + 1]);
      index += 1;
    }
  }
  if (destinations.length !== 1 || !NAVIGATION_DESTINATIONS.includes(destinations[0])) return undefined;
  if (sources.length > 1 || (sources.length === 1 && !SOURCE_ID.test(sources[0] || ""))) return undefined;
  return Object.freeze({ destination: destinations[0], sourceId: sources[0] });
}

export function controlCenterNavigationURL(value) {
  let parsed;
  try { parsed = new URL(value); } catch { return undefined; }
  if (
    parsed.protocol !== "codex-router:"
    || parsed.hostname !== "control-center"
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.hash
  ) return undefined;
  const destination = parsed.pathname === "/usage"
    ? "usage"
    : parsed.pathname === "/usage-resets" ? "usage-resets" : undefined;
  if (!destination) return undefined;
  const keys = [...parsed.searchParams.keys()];
  const sourceValues = parsed.searchParams.getAll("source");
  if (keys.some((key) => key !== "source") || sourceValues.length > 1) {
    return undefined;
  }
  const sourceId = sourceValues[0];
  if (sourceId !== undefined && !SOURCE_ID.test(sourceId)) return undefined;
  return Object.freeze({ destination, sourceId });
}
