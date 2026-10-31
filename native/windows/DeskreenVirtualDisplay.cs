// DeskreenVirtualDisplay (Windows)
//
// Creates a Windows virtual display through the Parsec Virtual Display
// Driver (VDD), positions it to the right of the current desktop and keeps
// it alive until the process exits or receives a shutdown command on stdin.
//
// The helper is spawned by the Electron main process, one instance per
// viewer. The Parsec driver removes the monitor when the keep-alive pings
// stop, so the helper also exits as soon as its parent process is gone.
//
// Parsec VDD is a signed Indirect Display Driver (IddCx) that can be
// installed independently of the Parsec app. The IOCTL protocol used here
// follows the public documentation of the nomi-san/parsec-vdd project.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DeskreenVirtualDisplay
{
	internal static class Program
	{
		private const string VddAdapterGuid = "{00b41627-04c4-429e-a26e-0265cf50c8fa}";
		private const string VddHardwareId = "Root\\Parsec\\VDA";

		private const uint VddIoctlAdd = 0x0022E004;
		private const uint VddIoctlRemove = 0x0022A008;
		private const uint VddIoctlUpdate = 0x0022A00C;
		private const uint VddIoctlVersion = 0x0022E010;

		private const int VddMaxDisplays = 16;
		private const int KeepAliveIntervalMs = 100;
		private const int HelperStartTimeoutMs = 15000;

		private const uint GenericRead = 0x80000000;
		private const uint GenericWrite = 0x40000000;
		private const uint FileShareRead = 0x00000001;
		private const uint FileShareWrite = 0x00000002;
		private const uint OpenExisting = 3;
		private const uint FileAttributeNormal = 0x00000080;
		private const uint FileFlagNoBuffering = 0x20000000;
		private const uint FileFlagOverlapped = 0x40000000;
		private const uint FileFlagWriteThrough = 0x80000000;

		private const uint CmGetDeviceInterfaceListPresent = 0x00000000;

		private const int DmPosition = 0x00000020;
		private const int DmDisplayOrientation = 0x00000080;
		private const int DmPelsWidth = 0x00080000;
		private const int DmPelsHeight = 0x00100000;
		private const int DmDisplayFrequency = 0x00400000;

		private const int DmdoDefault = 0;
		private const int Dmdo90 = 1;

		private const uint CdsUpdateregistry = 0x00000001;
		private const uint CdsNoreset = 0x10000000;

		private const uint SdcTopologyExtend = 0x00000004;
		private const uint SdcApply = 0x00000080;

		private const uint EddGetDeviceInterfaceName = 0x00000001;
		private const uint DisplayDeviceActive = 0x00000001;

		// Device code of the Parsec virtual monitor. Physical monitors also
		// expose a "UID<n>" token in their interface path, so matching the UID
		// alone can select the real screen and rotate it.
		private const string VddDisplayCode = "PSCCDD0";

		private static readonly object VddLock = new object();
		private static readonly object CleanupLock = new object();

		private static IntPtr vddHandle = IntPtr.Zero;
		private static int displayIndex = -1;
		private static string displayDeviceName = null;
		private static string displayMonitorId = null;
		private static int displayAddress = 0;
		private static int currentWidth = 0;
		private static int currentHeight = 0;
		private static int currentX = 0;
		private static int currentY = 0;
		private static string displayName = "Deskreen Display 1";
		private static int preferredRefreshRate = 60;
		private static int parentPid = 0;
		private static volatile bool running = true;
		private static bool cleanedUp = false;

		private static int Main(string[] args)
		{
			int requestedWidth = 1280;
			int requestedHeight = 800;
			bool checkOnly = false;

			for (int i = 0; i < args.Length; i++)
			{
				string arg = args[i];
				string next = i + 1 < args.Length ? args[i + 1] : null;

				if (arg == "--width" && next != null)
				{
					requestedWidth = ParseInt(next, requestedWidth);
					i++;
				}
				else if (arg == "--height" && next != null)
				{
					requestedHeight = ParseInt(next, requestedHeight);
					i++;
				}
				else if (arg == "--name" && next != null)
				{
					displayName = next;
					i++;
				}
				else if (arg == "--parent-pid" && next != null)
				{
					parentPid = ParseInt(next, 0);
					i++;
				}
				else if (arg == "--refresh" && next != null)
				{
					preferredRefreshRate = ParseInt(next, preferredRefreshRate);
					if (preferredRefreshRate < 24)
					{
						preferredRefreshRate = 24;
					}
					if (preferredRefreshRate > 480)
					{
						preferredRefreshRate = 480;
					}
					i++;
				}
				else if (arg == "--check")
				{
					checkOnly = true;
				}
			}

			if (checkOnly)
			{
				return CheckDriver();
			}

			if (requestedWidth < 64 || requestedHeight < 64)
			{
				Fail("width and height must be at least 64");
				return 2;
			}

			if (!OpenVdd())
			{
				Fail("the Parsec Virtual Display Driver is not installed or not accessible");
				return 3;
			}

			int version;
			if (!VddIoControl(VddIoctlVersion, null, out version, 1500))
			{
				Fail("the Parsec Virtual Display Driver did not answer the version query");
				CloseVdd();
				return 4;
			}

			int index;
			if (!VddIoControl(VddIoctlAdd, null, out index, 5000) || index < 0 || index >= VddMaxDisplays)
			{
				Fail("the Parsec Virtual Display Driver could not add a virtual display");
				CloseVdd();
				return 5;
			}

			displayIndex = index;

			// The driver watchdog removes monitors that are not pinged, so the
			// keep-alive must start before the (potentially slow) enumeration
			// and mode change below.
			int ignored;
			VddIoControl(VddIoctlUpdate, null, out ignored, 1000);
			StartKeepAlive();

			if (!WaitForDisplay(index, HelperStartTimeoutMs))
			{
				Fail("the virtual display was added but Windows did not report it");
				RemoveDisplay();
				CloseVdd();
				return 6;
			}

			PrintJson(
				"{\"event\":\"display-found\",\"deviceName\":" +
				Quote(displayDeviceName) +
				",\"monitorID\":" + Quote(displayMonitorId) +
				",\"width\":" + currentWidth.ToString(CultureInfo.InvariantCulture) +
				",\"height\":" + currentHeight.ToString(CultureInfo.InvariantCulture) +
				"}");

			if (!ApplyMode(requestedWidth, requestedHeight))
			{
				Fail("Windows rejected the virtual display mode");
				RemoveDisplay();
				CloseVdd();
				return 7;
			}
			PrintReady(version);

			StartStdinReader();
			StartParentWatcher();

			while (running)
			{
				Thread.Sleep(200);
			}

			Cleanup();
			return 0;
		}

		private static int CheckDriver()
		{
			if (!OpenVdd())
			{
				PrintJson("{\"event\":\"check\",\"supported\":false,\"reason\":\"parsec-vdd-not-installed\"}");
				return 0;
			}

			int version;
			bool ok = VddIoControl(VddIoctlVersion, null, out version, 1500);
			CloseVdd();

			if (!ok)
			{
				PrintJson("{\"event\":\"check\",\"supported\":false,\"reason\":\"parsec-vdd-unavailable\"}");
				return 0;
			}

			PrintJson(
				"{\"event\":\"check\",\"supported\":true,\"driver\":\"parsec-vdd\",\"version\":" +
				version.ToString(CultureInfo.InvariantCulture) + "}");
			return 0;
		}

		private static bool OpenVdd()
		{
			Guid interfaceGuid = new Guid(VddAdapterGuid);
			uint listLength = 0;

			int result = CM_Get_Device_Interface_List_Size(
				out listLength,
				ref interfaceGuid,
				null,
				CmGetDeviceInterfaceListPresent);

			if (result != 0 || listLength == 0)
			{
				return false;
			}

			StringBuilder buffer = new StringBuilder((int)listLength);
			result = CM_Get_Device_Interface_List(
				ref interfaceGuid,
				null,
				buffer,
				listLength,
				CmGetDeviceInterfaceListPresent);

			if (result != 0)
			{
				return false;
			}

			string[] paths = buffer.ToString().Split(
				new char[] { '\0' },
				StringSplitOptions.RemoveEmptyEntries);

			foreach (string path in paths)
			{
				IntPtr handle = CreateFileW(
					path,
					GenericRead | GenericWrite,
					FileShareRead | FileShareWrite,
					IntPtr.Zero,
					OpenExisting,
					FileAttributeNormal | FileFlagNoBuffering | FileFlagOverlapped | FileFlagWriteThrough,
					IntPtr.Zero);

				if (handle != IntPtr.Zero && handle != new IntPtr(-1))
				{
					vddHandle = handle;
					return true;
				}
			}

			return false;
		}

		private static void CloseVdd()
		{
			lock (VddLock)
			{
				if (vddHandle != IntPtr.Zero)
				{
					CloseHandle(vddHandle);
					vddHandle = IntPtr.Zero;
				}
			}
		}

		private static bool VddIoControl(uint code, byte[] input, out int output, int timeoutMs)
		{
			output = 0;

			lock (VddLock)
			{
				if (vddHandle == IntPtr.Zero)
				{
					return false;
				}

				byte[] inBuffer = new byte[32];
				if (input != null && input.Length > 0)
				{
					Array.Copy(input, inBuffer, Math.Min(input.Length, inBuffer.Length));
				}

				bool expectsOutput = code == VddIoctlAdd || code == VddIoctlVersion;
				// The driver is called with a 4-byte output buffer for every
				// control code, matching the reference implementation. Only
				// ADD and VERSION return a meaningful value.
				int outputSize = 4;
				IntPtr outBuffer = Marshal.AllocHGlobal(4);
				Marshal.WriteInt32(outBuffer, 0);

				Overlapped overlapped = new Overlapped();
				overlapped.hEvent = CreateEventW(IntPtr.Zero, true, false, IntPtr.Zero);

				if (overlapped.hEvent == IntPtr.Zero)
				{
					Marshal.FreeHGlobal(outBuffer);
					return false;
				}

				try
				{
					uint bytesReturned;
					DeviceIoControl(
						vddHandle,
						code,
						inBuffer,
						(uint)inBuffer.Length,
						outBuffer,
						(uint)outputSize,
						out bytesReturned,
						ref overlapped);

					uint transferred;
					bool success = GetOverlappedResultEx(
						vddHandle,
						ref overlapped,
						out transferred,
						(uint)timeoutMs,
						false);

					if (!success)
					{
						CancelIoEx(vddHandle, ref overlapped);
						GetOverlappedResult(vddHandle, ref overlapped, out transferred, true);
					}
					else if (expectsOutput)
					{
						output = Marshal.ReadInt32(outBuffer);
					}

					return success;
				}
				finally
				{
					CloseHandle(overlapped.hEvent);
					Marshal.FreeHGlobal(outBuffer);
				}
			}
		}

		private static bool WaitForDisplay(int index, int timeoutMs)
		{
			Stopwatch stopwatch = Stopwatch.StartNew();
			bool triedToExtend = false;

			while (stopwatch.ElapsedMilliseconds < timeoutMs && running)
			{
				string deviceName;
				int address;
				int width;
				int height;
				int x;
				int y;

				if (TryFindDisplay(index, out deviceName, out address, out width, out height, out x, out y))
				{
					displayDeviceName = deviceName;
					displayAddress = address;
					currentWidth = width;
					currentHeight = height;
					currentX = x;
					currentY = y;
					return true;
				}

				// A monitor that is plugged but not part of the desktop may
				// not appear in the GDI display list. Extend the desktop once
				// to force Windows to attach it.
				if (!triedToExtend && stopwatch.ElapsedMilliseconds > 2000)
				{
					triedToExtend = true;
					SetDisplayConfig(
						0,
						IntPtr.Zero,
						0,
						IntPtr.Zero,
						SdcTopologyExtend | SdcApply);
				}

				Thread.Sleep(100);
			}

			return false;
		}

		private static bool TryFindDisplay(
			int index,
			out string deviceName,
			out int address,
			out int width,
			out int height,
			out int x,
			out int y)
		{
			deviceName = null;
			address = 0;
			width = 0;
			height = 0;
			x = 0;
			y = 0;

			int expectedAddress = 0x100 + index;

			for (int i = 0; i < 64; i++)
			{
				DisplayDevice adapter = new DisplayDevice();
				adapter.cb = Marshal.SizeOf(typeof(DisplayDevice));

				if (!EnumDisplayDevicesW(null, i, ref adapter, 0))
				{
					break;
				}

				for (int j = 0; j < 16; j++)
				{
					DisplayDevice monitor = new DisplayDevice();
					monitor.cb = Marshal.SizeOf(typeof(DisplayDevice));

					if (!EnumDisplayDevicesW(
						adapter.DeviceName,
						j,
						ref monitor,
						EddGetDeviceInterfaceName))
					{
						break;
					}

					// The UID is not unique across vendors: physical monitors
					// also use "UID<n>" (for example UID256). Only the Parsec
					// display code identifies the virtual monitor, and it must
					// be attached to the desktop before its mode is changed.
					if (
						string.IsNullOrEmpty(monitor.DeviceID) ||
						monitor.DeviceID.IndexOf(
							VddDisplayCode,
							StringComparison.OrdinalIgnoreCase) < 0)
					{
						continue;
					}

					if ((monitor.StateFlags & DisplayDeviceActive) == 0)
					{
						continue;
					}

					if (ParseDisplayAddress(monitor.DeviceID) != expectedAddress)
					{
						continue;
					}

					deviceName = adapter.DeviceName;
					address = expectedAddress;
					displayMonitorId = monitor.DeviceID;

					DevMode mode = new DevMode();
					mode.dmSize = (short)Marshal.SizeOf(typeof(DevMode));

					if (EnumDisplaySettingsW(deviceName, -1, ref mode))
					{
						width = mode.dmPelsWidth;
						height = mode.dmPelsHeight;
						x = mode.dmPositionX;
						y = mode.dmPositionY;
					}

					return true;
				}
			}

			return false;
		}

		private static int ParseDisplayAddress(string deviceId)
		{
			if (string.IsNullOrEmpty(deviceId))
			{
				return 0;
			}

			int position = deviceId.IndexOf("UID", StringComparison.OrdinalIgnoreCase);
			if (position < 0)
			{
				return 0;
			}

			position += 3;
			int end = position;

			while (end < deviceId.Length && deviceId[end] >= '0' && deviceId[end] <= '9')
			{
				end++;
			}

			int address;
			int.TryParse(
				deviceId.Substring(position, end - position),
				NumberStyles.Integer,
				CultureInfo.InvariantCulture,
				out address);

			return address;
		}

		private static bool ApplyMode(int targetWidth, int targetHeight)
		{
			if (string.IsNullOrEmpty(displayDeviceName))
			{
				return false;
			}

			bool portrait = targetHeight > targetWidth;
			int desiredOrientation = portrait ? Dmdo90 : DmdoDefault;

			// EnumDisplaySettings lists modes in the monitor's current
			// orientation. Rotate first so the enumerated modes match the
			// requested orientation, then pick a mode from that list. Swapping
			// dimensions before enumeration can produce a mode Windows does
			// not advertise (DISP_CHANGE_BADMODE).
			if (GetCurrentOrientation() != desiredOrientation)
			{
				if (!SetOrientation(desiredOrientation))
				{
					Console.Error.WriteLine(
						"could not rotate " + displayDeviceName + " to " +
						desiredOrientation.ToString(CultureInfo.InvariantCulture));
					return false;
				}
			}

			DevMode chosen;
			if (!ChooseMode(displayDeviceName, targetWidth, targetHeight, out chosen))
			{
				Console.Error.WriteLine(
					"could not enumerate a display mode for " + displayDeviceName);
				return false;
			}

			Console.Error.WriteLine(
				"mode chosen: " +
				chosen.dmPelsWidth.ToString(CultureInfo.InvariantCulture) +
				"x" +
				chosen.dmPelsHeight.ToString(CultureInfo.InvariantCulture) +
				" @" +
				chosen.dmDisplayFrequency.ToString(CultureInfo.InvariantCulture) +
				"Hz for target " +
				targetWidth.ToString(CultureInfo.InvariantCulture) +
				"x" +
				targetHeight.ToString(CultureInfo.InvariantCulture));

			// Place the monitor to the right of every other display. When the
			// virtual display is the only active monitor, start at (0, 0).
			int positionX = GetRightmostEdge(displayDeviceName);
			if (positionX < 0)
			{
				positionX = 0;
			}

			chosen.dmPositionX = positionX;
			chosen.dmPositionY = 0;
			chosen.dmFields = DmPelsWidth | DmPelsHeight | DmPosition | DmDisplayFrequency;
			chosen.dmDisplayOrientation = desiredOrientation;
			chosen.dmFields |= DmDisplayOrientation;

			int result = ChangeDisplaySettingsExW(
				displayDeviceName,
				ref chosen,
				IntPtr.Zero,
				CdsUpdateregistry,
				IntPtr.Zero);

			if (result != 0)
			{
				// Some drivers reject an explicit refresh rate. The mode
				// dimensions are what matter, so retry without it.
				chosen.dmFields &= ~DmDisplayFrequency;
				result = ChangeDisplaySettingsExW(
					displayDeviceName,
					ref chosen,
					IntPtr.Zero,
					CdsUpdateregistry,
					IntPtr.Zero);
			}

			if (result != 0)
			{
				// Attach the new monitor to the desktop first, then retry.
				SetDisplayConfig(
					0,
					IntPtr.Zero,
					0,
					IntPtr.Zero,
					SdcTopologyExtend | SdcApply);
				Thread.Sleep(300);
				result = ChangeDisplaySettingsExW(
					displayDeviceName,
					ref chosen,
					IntPtr.Zero,
					CdsUpdateregistry,
					IntPtr.Zero);
			}

			if (result != 0)
			{
				// Deferred commit is the last resort for drivers that require
				// all changes to be staged before they are applied.
				result = ChangeDisplaySettingsExW(
					displayDeviceName,
					ref chosen,
					IntPtr.Zero,
					CdsUpdateregistry | CdsNoreset,
					IntPtr.Zero);

				if (result == 0)
				{
					result = ChangeDisplaySettingsExCommit(
						null,
						IntPtr.Zero,
						IntPtr.Zero,
						0,
						IntPtr.Zero);
				}
			}

			if (result != 0)
			{
				Console.Error.WriteLine(
					"ChangeDisplaySettingsEx failed with " +
					result.ToString(CultureInfo.InvariantCulture) +
					" for " + displayDeviceName);
				return false;
			}

			Thread.Sleep(300);
			RefreshCurrentMode();
			return currentWidth > 0 && currentHeight > 0;
		}

		private static int GetCurrentOrientation()
		{
			DevMode mode = new DevMode();
			mode.dmSize = (short)Marshal.SizeOf(typeof(DevMode));

			if (!EnumDisplaySettingsW(displayDeviceName, -1, ref mode))
			{
				return DmdoDefault;
			}

			return mode.dmDisplayOrientation;
		}

		private static bool SetOrientation(int orientation)
		{
			DevMode mode = new DevMode();
			mode.dmSize = (short)Marshal.SizeOf(typeof(DevMode));

			if (!EnumDisplaySettingsW(displayDeviceName, -1, ref mode))
			{
				return false;
			}

			if (mode.dmDisplayOrientation == orientation)
			{
				return true;
			}

			int previous = mode.dmDisplayOrientation;
			mode.dmDisplayOrientation = orientation;
			mode.dmFields = DmDisplayOrientation | DmPelsWidth | DmPelsHeight;

			// Toggling between landscape and portrait requires swapping the
			// dimensions of the current mode.
			if (((orientation + previous) % 2) != 0)
			{
				int swap = mode.dmPelsWidth;
				mode.dmPelsWidth = mode.dmPelsHeight;
				mode.dmPelsHeight = swap;
			}

			int result = ChangeDisplaySettingsExW(
				displayDeviceName,
				ref mode,
				IntPtr.Zero,
				CdsUpdateregistry,
				IntPtr.Zero);

			if (result != 0)
			{
				return false;
			}

			Thread.Sleep(500);
			return true;
		}

		private static bool ChooseMode(
			string deviceName,
			int targetWidth,
			int targetHeight,
			out DevMode chosen)
		{
			chosen = new DevMode();
			chosen.dmSize = (short)Marshal.SizeOf(typeof(DevMode));

			List<DevMode> modes = new List<DevMode>();

			for (int i = 0; i < 512; i++)
			{
				DevMode mode = new DevMode();
				mode.dmSize = (short)Marshal.SizeOf(typeof(DevMode));

				if (!EnumDisplaySettingsW(deviceName, i, ref mode))
				{
					break;
				}

				if (mode.dmPelsWidth < 320 || mode.dmPelsHeight < 240)
				{
					continue;
				}

				if (mode.dmPelsWidth > 8192 || mode.dmPelsHeight > 4320)
				{
					continue;
				}

				modes.Add(mode);
			}

			if (modes.Count == 0)
			{				DevMode current = new DevMode();
				current.dmSize = (short)Marshal.SizeOf(typeof(DevMode));

				if (!EnumDisplaySettingsW(deviceName, -1, ref current))
				{
					return false;
				}

				current.dmPelsWidth = targetWidth;
				current.dmPelsHeight = targetHeight;
				chosen = current;
				return true;
			}

			bool hasExact = false;
			DevMode exact = new DevMode();
			bool hasBest = false;
			DevMode best = new DevMode();
			double bestScore = double.MaxValue;
			double targetAspect = (double)targetWidth / (double)targetHeight;

			foreach (DevMode mode in modes)
			{
				if (mode.dmPelsWidth == targetWidth && mode.dmPelsHeight == targetHeight)
				{
					if (!hasExact || PreferRefreshRate(mode, exact))
					{
						exact = mode;
						hasExact = true;
					}
				}

				double aspect = (double)mode.dmPelsWidth / (double)mode.dmPelsHeight;
				double score = Math.Abs(aspect - targetAspect) * 10000.0
					+ Math.Abs(mode.dmPelsWidth - targetWidth)
					+ Math.Abs(mode.dmPelsHeight - targetHeight)
					+ Math.Abs(mode.dmDisplayFrequency - preferredRefreshRate) * 0.1;

				if (score < bestScore || (Math.Abs(score - bestScore) < 0.001 && hasBest && PreferRefreshRate(mode, best)))
				{
					bestScore = score;
					best = mode;
					hasBest = true;
				}
			}

			if (hasExact)
			{
				chosen = exact;
				return true;
			}

			if (hasBest)
			{
				chosen = best;
				return true;
			}

			return false;
		}

		private static bool PreferRefreshRate(DevMode candidate, DevMode current)
		{
			int candidateDistance = Math.Abs(
				candidate.dmDisplayFrequency - preferredRefreshRate);
			int currentDistance = Math.Abs(
				current.dmDisplayFrequency - preferredRefreshRate);
			return candidateDistance < currentDistance;
		}

		private static int GetRightmostEdge(string excludeDeviceName)
		{
			int rightmost = -1;

			for (int i = 0; i < 64; i++)
			{
				DisplayDevice adapter = new DisplayDevice();
				adapter.cb = Marshal.SizeOf(typeof(DisplayDevice));

				if (!EnumDisplayDevicesW(null, i, ref adapter, 0))
				{
					break;
				}

				if (!string.IsNullOrEmpty(excludeDeviceName)
					&& string.Equals(
						adapter.DeviceName,
						excludeDeviceName,
						StringComparison.OrdinalIgnoreCase))
				{
					continue;
				}

				if ((adapter.StateFlags & DisplayDeviceActive) == 0)
				{
					continue;
				}

				DevMode mode = new DevMode();
				mode.dmSize = (short)Marshal.SizeOf(typeof(DevMode));

				if (!EnumDisplaySettingsW(adapter.DeviceName, -1, ref mode))
				{
					continue;
				}

				if (mode.dmPelsWidth <= 0 || mode.dmPelsHeight <= 0)
				{
					continue;
				}

				int edge = mode.dmPositionX + mode.dmPelsWidth;
				if (edge > rightmost)
				{
					rightmost = edge;
				}
			}

			return rightmost;
		}

		private static void RefreshCurrentMode()
		{
			if (string.IsNullOrEmpty(displayDeviceName))
			{
				return;
			}

			DevMode mode = new DevMode();
			mode.dmSize = (short)Marshal.SizeOf(typeof(DevMode));

			if (EnumDisplaySettingsW(displayDeviceName, -1, ref mode))
			{
				currentWidth = mode.dmPelsWidth;
				currentHeight = mode.dmPelsHeight;
				currentX = mode.dmPositionX;
				currentY = mode.dmPositionY;
			}
		}

		private static void StartKeepAlive()
		{
			Thread thread = new Thread(delegate()
			{
				while (running)
				{
					int ignored;
					VddIoControl(VddIoctlUpdate, null, out ignored, 1000);
					Thread.Sleep(KeepAliveIntervalMs);
				}
			});

			thread.IsBackground = true;
			thread.Name = "deskreen-vdd-keepalive";
			thread.Start();
		}

		private static void StartStdinReader()
		{
			Thread thread = new Thread(delegate()
			{
				try
				{
					string line;
					while (running && (line = Console.In.ReadLine()) != null)
					{
						HandleStdinLine(line);
					}
				}
				catch
				{
					// The parent closed stdin while the app was shutting down.
				}

				if (running)
				{
					running = false;
				}
			});

			thread.IsBackground = true;
			thread.Name = "deskreen-vdd-stdin";
			thread.Start();
		}

		private static void HandleStdinLine(string line)
		{
			string trimmed = line.Trim();
			if (trimmed.Length == 0)
			{
				return;
			}

			if (trimmed == "shutdown")
			{
				running = false;
				Cleanup();
				Environment.Exit(0);
				return;
			}

			int width;
			int height;

			if (TryReadResizeCommand(trimmed, out width, out height))
			{
				if (width < 64 || height < 64)
				{
					return;
				}

				int refreshIndex = trimmed.IndexOf(
					"\"refresh\"",
					StringComparison.Ordinal);
				if (refreshIndex >= 0)
				{
					int requestedRefresh = ReadJsonInteger(
						trimmed,
						refreshIndex + 9);
					if (requestedRefresh >= 24 && requestedRefresh <= 480)
					{
						preferredRefreshRate = requestedRefresh;
					}
				}

				bool resized = ApplyMode(width, height);

				if (resized)
				{
					PrintJson(
						"{\"event\":\"resized\",\"displayID\":" +
						displayAddress.ToString(CultureInfo.InvariantCulture) +
						",\"deviceName\":" + Quote(displayDeviceName) +
						",\"width\":" + currentWidth.ToString(CultureInfo.InvariantCulture) +
						",\"height\":" + currentHeight.ToString(CultureInfo.InvariantCulture) +
						",\"x\":" + currentX.ToString(CultureInfo.InvariantCulture) +
						",\"y\":" + currentY.ToString(CultureInfo.InvariantCulture) +
						",\"boundsWidth\":" + currentWidth.ToString(CultureInfo.InvariantCulture) +
						",\"boundsHeight\":" + currentHeight.ToString(CultureInfo.InvariantCulture) +
						"}");
				}
				else
				{
					PrintJson("{\"event\":\"resize-error\",\"message\":\"could not apply the requested display mode\"}");
				}
			}
		}

		private static bool TryReadResizeCommand(string line, out int width, out int height)
		{
			width = 0;
			height = 0;

			// Minimal JSON reader: the only structured command we accept is
			// {"command":"resize","width":N,"height":M}. Keeping it small
			// avoids adding a JSON dependency to the standalone helper.
			if (line.IndexOf("\"command\"", StringComparison.Ordinal) < 0
				|| line.IndexOf("\"resize\"", StringComparison.Ordinal) < 0)
			{
				return false;
			}

			int widthIndex = line.IndexOf("\"width\"", StringComparison.Ordinal);
			int heightIndex = line.IndexOf("\"height\"", StringComparison.Ordinal);

			if (widthIndex < 0 || heightIndex < 0)
			{
				return false;
			}

			width = ReadJsonInteger(line, widthIndex + 7);
			height = ReadJsonInteger(line, heightIndex + 8);
			return width > 0 && height > 0;
		}

		private static int ReadJsonInteger(string text, int start)
		{
			int colon = text.IndexOf(':', start);
			if (colon < 0)
			{
				return 0;
			}

			int position = colon + 1;
			while (position < text.Length && char.IsWhiteSpace(text[position]))
			{
				position++;
			}

			int end = position;
			while (end < text.Length && (text[end] == '-' || char.IsDigit(text[end])))
			{
				end++;
			}

			int value;
			int.TryParse(
				text.Substring(position, end - position),
				NumberStyles.Integer,
				CultureInfo.InvariantCulture,
				out value);

			return value;
		}

		private static void StartParentWatcher()
		{
			if (parentPid <= 0)
			{
				return;
			}

			Thread thread = new Thread(delegate()
			{
				while (running)
				{
					Thread.Sleep(2000);

					if (!running)
					{
						return;
					}

					try
					{
						using (Process process = Process.GetProcessById(parentPid))
						{
							if (process.HasExited)
							{
								throw new InvalidOperationException("parent process exited");
							}
						}
					}
					catch
					{
						running = false;
						Cleanup();
						Environment.Exit(0);
						return;
					}
				}
			});

			thread.IsBackground = true;
			thread.Name = "deskreen-vdd-parent-watch";
			thread.Start();
		}

		private static void RemoveDisplay()
		{
			if (vddHandle == IntPtr.Zero || displayIndex < 0)
			{
				return;
			}

			byte[] input = new byte[2];
			input[1] = (byte)(displayIndex & 0xFF);

			int ignored;
			VddIoControl(VddIoctlRemove, input, out ignored, 1000);
			VddIoControl(VddIoctlUpdate, null, out ignored, 1000);
			displayIndex = -1;
		}

		private static void Cleanup()
		{
			lock (CleanupLock)
			{
				if (cleanedUp)
				{
					return;
				}

				cleanedUp = true;
			}

			running = false;

			try
			{
				RemoveDisplay();
			}
			catch
			{
				// Best effort: the driver watchdog removes orphaned monitors.
			}

			CloseVdd();
		}

		private static void PrintReady(int version)
		{
			PrintJson(
				"{\"event\":\"ready\",\"displayID\":" +
				displayAddress.ToString(CultureInfo.InvariantCulture) +
				",\"deviceName\":" + Quote(displayDeviceName) +
				",\"monitorID\":" + Quote(displayMonitorId) +
				",\"name\":" + Quote(displayName) +
				",\"width\":" + currentWidth.ToString(CultureInfo.InvariantCulture) +
				",\"height\":" + currentHeight.ToString(CultureInfo.InvariantCulture) +
				",\"x\":" + currentX.ToString(CultureInfo.InvariantCulture) +
				",\"y\":" + currentY.ToString(CultureInfo.InvariantCulture) +
				",\"boundsWidth\":" + currentWidth.ToString(CultureInfo.InvariantCulture) +
				",\"boundsHeight\":" + currentHeight.ToString(CultureInfo.InvariantCulture) +
				",\"driver\":\"parsec-vdd\",\"version\":" + version.ToString(CultureInfo.InvariantCulture) +
				",\"hardwareId\":" + Quote(VddHardwareId) +
				"}");
		}

		private static void PrintJson(string json)
		{
			Console.Out.WriteLine(json);
			Console.Out.Flush();
		}

		private static void Fail(string message)
		{
			Console.Error.WriteLine(message);
			Console.Error.Flush();
		}

		private static string Quote(string value)
		{
			if (value == null)
			{
				return "null";
			}

			StringBuilder builder = new StringBuilder();
			builder.Append('"');

			foreach (char character in value)
			{
				switch (character)
				{
					case '"':
						builder.Append("\\\"");
						break;
					case '\\':
						builder.Append("\\\\");
						break;
					case '\n':
						builder.Append("\\n");
						break;
					case '\r':
						builder.Append("\\r");
						break;
					case '\t':
						builder.Append("\\t");
						break;
					default:
						if (character < 0x20)
						{
							builder.Append("\\u");
							builder.Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
						}
						else
						{
							builder.Append(character);
						}
						break;
				}
			}

			builder.Append('"');
			return builder.ToString();
		}

		private static int ParseInt(string value, int fallback)
		{
			int parsed;
			if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
			{
				return parsed;
			}

			return fallback;
		}

		[StructLayout(LayoutKind.Sequential)]
		private struct Overlapped
		{
			public IntPtr Internal;
			public IntPtr InternalHigh;
			public uint Offset;
			public uint OffsetHigh;
			public IntPtr hEvent;
		}

		[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
		private struct DisplayDevice
		{
			public int cb;

			[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
			public string DeviceName;

			[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
			public string DeviceString;

			public uint StateFlags;

			[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
			public string DeviceID;

			[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
			public string DeviceKey;
		}

		[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
		private struct DevMode
		{
			[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
			public string dmDeviceName;

			public short dmSpecVersion;
			public short dmDriverVersion;
			public short dmSize;
			public short dmDriverExtra;
			public int dmFields;
			public int dmPositionX;
			public int dmPositionY;
			public int dmDisplayOrientation;
			public int dmDisplayFixedOutput;
			public short dmColor;
			public short dmDuplex;
			public short dmYResolution;
			public short dmTTOption;
			public short dmCollate;

			[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
			public string dmFormName;

			public short dmLogPixels;
			public int dmBitsPerPel;
			public int dmPelsWidth;
			public int dmPelsHeight;
			public int dmDisplayFlags;
			public int dmDisplayFrequency;
			public int dmICMMethod;
			public int dmICMIntent;
			public int dmMediaType;
			public int dmDitherType;
			public int dmReserved1;
			public int dmReserved2;
			public int dmPanningWidth;
			public int dmPanningHeight;
		}

		[DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
		private static extern int CM_Get_Device_Interface_List_Size(
			out uint listLength,
			ref Guid interfaceClassGuid,
			string deviceId,
			uint flags);

		[DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
		private static extern int CM_Get_Device_Interface_List(
			ref Guid interfaceClassGuid,
			string deviceId,
			StringBuilder buffer,
			uint bufferLength,
			uint flags);

		[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
		private static extern IntPtr CreateFileW(
			string fileName,
			uint desiredAccess,
			uint shareMode,
			IntPtr securityAttributes,
			uint creationDisposition,
			uint flagsAndAttributes,
			IntPtr templateFile);

		[DllImport("kernel32.dll", SetLastError = true)]
		private static extern bool DeviceIoControl(
			IntPtr device,
			uint controlCode,
			byte[] inBuffer,
			uint inBufferSize,
			IntPtr outBuffer,
			uint outBufferSize,
			out uint bytesReturned,
			ref Overlapped overlapped);

		[DllImport("kernel32.dll", SetLastError = true)]
		private static extern bool GetOverlappedResultEx(
			IntPtr file,
			ref Overlapped overlapped,
			out uint bytesTransferred,
			uint milliseconds,
			bool alertable);

		[DllImport("kernel32.dll", SetLastError = true)]
		private static extern bool GetOverlappedResult(
			IntPtr file,
			ref Overlapped overlapped,
			out uint bytesTransferred,
			bool wait);

		[DllImport("kernel32.dll", SetLastError = true)]
		private static extern bool CancelIoEx(IntPtr file, ref Overlapped overlapped);

		[DllImport("kernel32.dll", SetLastError = true)]
		private static extern bool CloseHandle(IntPtr handle);

		[DllImport("kernel32.dll", SetLastError = true)]
		private static extern IntPtr CreateEventW(
			IntPtr eventAttributes,
			bool manualReset,
			bool initialState,
			IntPtr name);

		[DllImport("user32.dll", CharSet = CharSet.Unicode)]
		private static extern bool EnumDisplayDevicesW(
			string device,
			int deviceNumber,
			ref DisplayDevice displayDevice,
			uint flags);

		[DllImport("user32.dll", CharSet = CharSet.Unicode)]
		private static extern bool EnumDisplaySettingsW(
			string deviceName,
			int modeNumber,
			ref DevMode devMode);

		[DllImport("user32.dll", CharSet = CharSet.Unicode)]
		private static extern int ChangeDisplaySettingsExW(
			string deviceName,
			ref DevMode devMode,
			IntPtr window,
			uint flags,
			IntPtr param);

		[DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "ChangeDisplaySettingsExW")]
		private static extern int ChangeDisplaySettingsExCommit(
			string deviceName,
			IntPtr devMode,
			IntPtr window,
			uint flags,
			IntPtr param);

		[DllImport("user32.dll")]
		private static extern int SetDisplayConfig(
			uint pathArrayElements,
			IntPtr pathArray,
			uint modeInfoArrayElements,
			IntPtr modeInfoArray,
			uint flags);
	}
}
