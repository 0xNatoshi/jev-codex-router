// `control picker all <show|hide>` passes the flag as the second value while
// `control picker set <slug> <show|hide>` passes it as the third, so the
// two forms cannot share one positional layout.
export function pickerCommandArgs(args) {
  if (args[1] === "all") return [args[1], undefined, args[2]];
  return [args[1], args[2], args[3]];
}
