import { execFile as execFileCallback } from "node:child_process";

// Task Scheduler's `State` can remain Running after its only instance has
// gone, and the COM instance enumeration can outlive its process too. The
// launcher process tree is therefore probed directly: the registered task's
// wscript process must still reference its exact generated VBS launcher. A
// manually started `src/start.mjs` is deliberately not enough to prove that
// Task Scheduler is supervising anything. A
// query failure is deliberately inconclusive so a restricted shell cannot
// turn a slow-but-valid startup into a false failure.
export async function windowsScheduledTaskState({
  taskName = "Codex Router",
  execFile = execFileCallback,
  platform = process.platform,
  timeoutMs = 10_000,
  powershellExecutable = "powershell.exe",
} = {}) {
  // Task Scheduler queries must not block the event loop that owns the
  // concurrent router-health probe.
  if (platform !== "win32") return Promise.resolve(undefined);

  const script = [
    "try {",
    "  Get-ScheduledTask -TaskName $env:CODEX_ROUTER_TASK -ErrorAction Stop | Out-Null",
    "  $info = Get-ScheduledTaskInfo -TaskName $env:CODEX_ROUTER_TASK -ErrorAction Stop",
    "  $scheduler = New-Object -ComObject Schedule.Service",
    "  $scheduler.Connect()",
    "  $task = $scheduler.GetFolder('\\').GetTask($env:CODEX_ROUTER_TASK)",
    "  $instances = @($task.GetInstances(0) | Where-Object { $null -ne $_ })",
    "  $action = $task.Definition.Actions.Item(1)",
    "  $launcherMatch = [regex]::Match([string]$action.Arguments, '\"([^\"]*start-codex-router-hidden\\.vbs)\"', [Text.RegularExpressions.RegexOptions]::IgnoreCase)",
    "  $launcherPath = if ($launcherMatch.Success) { $launcherMatch.Groups[1].Value } else { $null }",
    "  $launcher = $null",
    "  if ($launcherPath -and [IO.Path]::GetFileName([string]$action.Path) -ieq 'wscript.exe') {",
    "    $launcher = Get-CimInstance Win32_Process -ErrorAction Stop |",
    "      Where-Object { $_.ProcessId -ne $PID -and $_.Name -ieq 'wscript.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($launcherPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |",
    "      Select-Object -First 1",
    "  }",
    "  [Console]::Out.Write($instances.Count.ToString() + '|' + $info.LastTaskResult + '|' + $(if ($launcher) { '1' } else { '0' }))",
    "} catch { exit 1 }",
  ].join("\n");

  const command = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ];
  const options = {
    encoding: "utf8",
    env: { ...process.env, CODEX_ROUTER_TASK: taskName },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    windowsHide: true,
  };

  try {
    const output = String(
      await new Promise((resolve, reject) => {
        execFile(powershellExecutable, command, options, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      }),
    ).trim();
    const fields = output.split("|");
    if (fields.length < 2) return undefined;
    const instanceCount = Number(fields[0]);
    const lastTaskResult = Number(fields[1]);
    const launcherAlive = fields.length > 2 ? fields[2] === "1" : undefined;
    if (!Number.isSafeInteger(instanceCount) || instanceCount < 0) return undefined;
    if (!Number.isSafeInteger(lastTaskResult) || lastTaskResult < 0) return undefined;
    return { instanceCount, lastTaskResult, launcherAlive };
  } catch {
    return undefined;
  }
}
