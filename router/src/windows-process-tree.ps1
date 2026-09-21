param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $Payload
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Node does not expose Windows Job Objects. This tiny owner starts the target
# suspended, assigns it before any target code can create a child, and resumes
# it only after JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is active. The helper owns
# the sole job handle: timeout/owner termination closes it in the kernel, while
# ordinary target exit explicitly terminates and observes all residual members
# before returning the target's original exit status.
$jobSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CodexRouter {
  public static class WindowsJobRunner {
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint INFINITE = 0xffffffff;
    private const uint WAIT_FAILED = 0xffffffff;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
      public int cb;
      public string lpReserved;
      public string lpDesktop;
      public string lpTitle;
      public int dwX;
      public int dwY;
      public int dwXSize;
      public int dwYSize;
      public int dwXCountChars;
      public int dwYCountChars;
      public int dwFillAttribute;
      public uint dwFlags;
      public short wShowWindow;
      public short cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX {
      public STARTUPINFO StartupInfo;
      public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES {
      public int nLength;
      public IntPtr lpSecurityDescriptor;
      [MarshalAs(UnmanagedType.Bool)]
      public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
      public long TotalUserTime;
      public long TotalKernelTime;
      public long ThisPeriodTotalUserTime;
      public long ThisPeriodTotalKernelTime;
      public uint TotalPageFaultCount;
      public uint TotalProcesses;
      public uint ActiveProcesses;
      public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
      IntPtr job,
      int informationClass,
      IntPtr information,
      uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
      IntPtr job,
      int informationClass,
      out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
      uint informationLength,
      IntPtr returnLength
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
      string applicationName,
      StringBuilder commandLine,
      IntPtr processAttributes,
      IntPtr threadAttributes,
      bool inheritHandles,
      uint creationFlags,
      IntPtr environment,
      string currentDirectory,
      ref STARTUPINFOEX startupInfo,
      out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
      IntPtr attributeList,
      int attributeCount,
      int flags,
      ref IntPtr size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
      IntPtr attributeList,
      uint flags,
      IntPtr attribute,
      IntPtr value,
      IntPtr size,
      IntPtr previousValue,
      IntPtr returnSize
    );

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(
      IntPtr sourceProcess,
      IntPtr sourceHandle,
      IntPtr targetProcess,
      out IntPtr targetHandle,
      uint desiredAccess,
      bool inheritHandle,
      uint options
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(
      string fileName,
      uint desiredAccess,
      uint shareMode,
      ref SECURITY_ATTRIBUTES securityAttributes,
      uint creationDisposition,
      uint flagsAndAttributes,
      IntPtr templateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(
      uint count,
      IntPtr[] handles,
      bool waitAll,
      uint milliseconds
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
      uint desiredAccess,
      bool inheritHandle,
      uint processId
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    private static void ThrowLastError(string operation) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    private static string QuoteArgument(string value) {
      if (value.Length > 0 && value.IndexOfAny(new [] { ' ', '\t', '\n', '\v', '"' }) < 0) {
        return value;
      }
      var result = new StringBuilder("\"");
      var backslashes = 0;
      foreach (var character in value) {
        if (character == '\\') {
          backslashes += 1;
        } else if (character == '"') {
          result.Append('\\', backslashes * 2 + 1);
          result.Append('"');
          backslashes = 0;
        } else {
          result.Append('\\', backslashes);
          result.Append(character);
          backslashes = 0;
        }
      }
      result.Append('\\', backslashes * 2);
      result.Append('"');
      return result.ToString();
    }

    private static string CommandLine(string executable, string[] arguments, bool verbatim) {
      var result = new StringBuilder(QuoteArgument(executable));
      if (arguments.Length == 0) return result.ToString();
      result.Append(' ');
      if (verbatim) result.Append(String.Join(" ", arguments));
      else result.Append(String.Join(" ", Array.ConvertAll(arguments, QuoteArgument)));
      return result.ToString();
    }

    private static bool ValidHandle(IntPtr handle) {
      return handle != IntPtr.Zero && handle != INVALID_HANDLE_VALUE;
    }

    private static IntPtr NullStandardHandle() {
      var attributes = new SECURITY_ATTRIBUTES();
      attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
      attributes.bInheritHandle = true;
      var handle = CreateFile(
        "NUL",
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        ref attributes,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        IntPtr.Zero
      );
      if (!ValidHandle(handle)) ThrowLastError("Could not open NUL for a missing standard handle");
      return handle;
    }

    private static IntPtr DedicatedStandardHandle(int identifier) {
      var source = GetStdHandle(identifier);
      if (!ValidHandle(source)) return NullStandardHandle();
      IntPtr duplicate;
      var current = GetCurrentProcess();
      if (!DuplicateHandle(
        current,
        source,
        current,
        out duplicate,
        0,
        true,
        DUPLICATE_SAME_ACCESS
      )) ThrowLastError("Could not duplicate a standard handle for the router command");
      return duplicate;
    }

    private static IntPtr CreateHandleAllowList(IntPtr[] handles, out IntPtr handleValues) {
      handleValues = IntPtr.Zero;
      var listSize = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize);
      if (listSize == IntPtr.Zero) {
        ThrowLastError("Could not size the router command handle allowlist");
      }
      var attributeList = Marshal.AllocHGlobal(listSize);
      var initialized = false;
      try {
        if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref listSize)) {
          ThrowLastError("Could not initialize the router command handle allowlist");
        }
        initialized = true;
        handleValues = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
        for (var index = 0; index < handles.Length; index += 1) {
          Marshal.WriteIntPtr(handleValues, index * IntPtr.Size, handles[index]);
        }
        if (!UpdateProcThreadAttribute(
          attributeList,
          0,
          PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
          handleValues,
          new IntPtr(IntPtr.Size * handles.Length),
          IntPtr.Zero,
          IntPtr.Zero
        )) ThrowLastError("Could not restrict inherited router command handles");
        return attributeList;
      } catch {
        if (initialized) DeleteProcThreadAttributeList(attributeList);
        Marshal.FreeHGlobal(attributeList);
        if (handleValues != IntPtr.Zero) {
          Marshal.FreeHGlobal(handleValues);
          handleValues = IntPtr.Zero;
        }
        throw;
      }
    }

    private static void ConfigureKillOnClose(IntPtr job) {
      var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      var length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      var buffer = Marshal.AllocHGlobal(length);
      try {
        Marshal.StructureToPtr(information, buffer, false);
        if (!SetInformationJobObject(
          job,
          JobObjectExtendedLimitInformation,
          buffer,
          (uint)length
        )) ThrowLastError("Could not configure the router process Job Object");
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    private static void WaitForEmptyJob(IntPtr job) {
      var length = (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
      var deadline = DateTime.UtcNow.AddSeconds(5);
      while (true) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
        if (!QueryInformationJobObject(
          job,
          JobObjectBasicAccountingInformation,
          out accounting,
          length,
          IntPtr.Zero
        )) ThrowLastError("Could not verify router process Job Object cleanup");
        if (accounting.ActiveProcesses == 0) return;
        if (DateTime.UtcNow >= deadline) {
          throw new TimeoutException("The router process Job Object did not become empty.");
        }
        Thread.Sleep(20);
      }
    }

    public static int Run(
      string executable,
      string[] arguments,
      bool windowsVerbatimArguments,
      bool windowsHide,
      uint ownerProcessId,
      string currentDirectory
    ) {
      var job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) ThrowLastError("Could not create the router process Job Object");
      var owner = OpenProcess(SYNCHRONIZE, false, ownerProcessId);
      if (owner == IntPtr.Zero) {
        CloseHandle(job);
        ThrowLastError("Could not monitor the router command owner");
      }
      var process = new PROCESS_INFORMATION();
      var standardHandles = new IntPtr[3];
      var handleValues = IntPtr.Zero;
      var startup = new STARTUPINFOEX();
      var created = false;
      var assigned = false;
      try {
        ConfigureKillOnClose(job);
        standardHandles[0] = DedicatedStandardHandle(-10);
        standardHandles[1] = DedicatedStandardHandle(-11);
        standardHandles[2] = DedicatedStandardHandle(-12);
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = standardHandles[0];
        startup.StartupInfo.hStdOutput = standardHandles[1];
        startup.StartupInfo.hStdError = standardHandles[2];
        startup.lpAttributeList = CreateHandleAllowList(standardHandles, out handleValues);
        var commandLine = new StringBuilder(CommandLine(
          executable,
          arguments,
          windowsVerbatimArguments
        ));
        var creationFlags = CREATE_SUSPENDED |
          EXTENDED_STARTUPINFO_PRESENT |
          (windowsHide ? CREATE_NO_WINDOW : 0u);
        if (!CreateProcess(
          executable,
          commandLine,
          IntPtr.Zero,
          IntPtr.Zero,
          true,
          creationFlags,
          IntPtr.Zero,
          currentDirectory,
          ref startup,
          out process
        )) ThrowLastError("Could not start the router command inside its Job Object");
        created = true;
        if (!AssignProcessToJobObject(job, process.hProcess)) {
          ThrowLastError("Could not contain the router command in its Job Object");
        }
        assigned = true;
        if (ResumeThread(process.hThread) == 0xffffffff) {
          ThrowLastError("Could not resume the contained router command");
        }
        var waitResult = WaitForMultipleObjects(
          2,
          new [] { process.hProcess, owner },
          false,
          INFINITE
        );
        if (waitResult == WAIT_FAILED) {
          ThrowLastError("Could not wait for the router command or its owner");
        }
        if (waitResult == 1) {
          if (!TerminateJobObject(job, 1)) {
            ThrowLastError("Could not terminate a router command whose owner exited");
          }
          WaitForEmptyJob(job);
          return 143;
        }
        uint exitCode;
        if (!GetExitCodeProcess(process.hProcess, out exitCode)) {
          ThrowLastError("Could not read the contained router command exit code");
        }
        if (!TerminateJobObject(job, 1)) {
          ThrowLastError("Could not terminate residual router command descendants");
        }
        WaitForEmptyJob(job);
        return unchecked((int)exitCode);
      } finally {
        if (created && !assigned) TerminateProcess(process.hProcess, 1);
        if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
        if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
        if (startup.lpAttributeList != IntPtr.Zero) {
          DeleteProcThreadAttributeList(startup.lpAttributeList);
          Marshal.FreeHGlobal(startup.lpAttributeList);
        }
        if (handleValues != IntPtr.Zero) Marshal.FreeHGlobal(handleValues);
        foreach (var handle in standardHandles) {
          if (ValidHandle(handle)) CloseHandle(handle);
        }
        CloseHandle(owner);
        CloseHandle(job);
      }
    }
  }
}
'@

try {
  if ([string]$ExecutionContext.SessionState.LanguageMode -ne "FullLanguage") {
    throw "Windows process containment requires PowerShell FullLanguage mode; this host's application-control policy exposes $($ExecutionContext.SessionState.LanguageMode)."
  }
  $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
  $request = ConvertFrom-Json -InputObject $decoded
  if ([string]::IsNullOrWhiteSpace([string]$request.command)) {
    throw "The contained router command is missing."
  }
  $arguments = @($request.arguments | ForEach-Object { [string]$_ })
  try {
    Add-Type -TypeDefinition $jobSource -Language CSharp
  } catch {
    throw "Windows process containment requires application-control policy to permit PowerShell Add-Type: $($_.Exception.Message)"
  }
  exit [CodexRouter.WindowsJobRunner]::Run(
    [string]$request.command,
    [string[]]$arguments,
    [bool]$request.windowsVerbatimArguments,
    [bool]$request.windowsHide,
    [uint32]$request.ownerProcessId,
    (Get-Location).Path
  )
} catch {
  [Console]::Error.WriteLine("Codex Router process containment failed: {0}", $_.Exception.Message)
  exit 1
}
