using System.Runtime.InteropServices;

// The class belongs to the Native namespace
namespace BimGo.Native
{
    /// <summary>
    /// Hand-written joystick interop (winmm.dll) (input round B2, build B2-C): Windows' own joystick API (<c>winmm.dll</c>,
    /// always there) for generic controllers XInput doesn't see. Read only.
    /// </summary>
    internal static class Joystick
    {
        public const uint JOYERR_NOERROR = 0;

        /// <summary>Every axis, the buttons and the hat as an angle (hundredths of a degree).</summary>
        public const uint JOY_RETURNALL_CONTINUOUS_POV = 0x00FF | 0x0200;

        public const uint JOYCAPS_HASZ = 0x0001, JOYCAPS_HASR = 0x0002, JOYCAPS_HASU = 0x0004, JOYCAPS_HASV = 0x0008, JOYCAPS_HASPOV = 0x0010;

        /// <summary>The hat at rest.</summary>
        public const uint JOY_POVCENTERED = 0xFFFF;

        /// <summary>JOYINFOEX.</summary>
        [StructLayout(LayoutKind.Sequential)]
        public struct JOYINFOEX
        {
            public uint dwSize;
            public uint dwFlags;
            public uint dwXpos;
            public uint dwYpos;
            public uint dwZpos;
            public uint dwRpos;
            public uint dwUpos;
            public uint dwVpos;
            public uint dwButtons;
            public uint dwButtonNumber;
            public uint dwPOV;
            public uint dwReserved1;
            public uint dwReserved2;
        }

        /// <summary>JOYCAPSW.</summary>
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct JOYCAPSW
        {
            public ushort wMid;
            public ushort wPid;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname;
            public uint wXmin, wXmax, wYmin, wYmax, wZmin, wZmax;
            public uint wNumButtons, wPeriodMin, wPeriodMax;
            public uint wRmin, wRmax, wUmin, wUmax, wVmin, wVmax;
            public uint wCaps, wMaxAxes, wNumAxes, wMaxButtons;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szRegKey;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szOEMVxD;
        }

        /// <summary>How many joystick ids the driver supports (not how many are plugged in).</summary>
        [DllImport("winmm.dll")]
        public static extern uint joyGetNumDevs();

        /// <summary>Reads one joystick (JOYERR_NOERROR, or an error when nothing is there).</summary>
        [DllImport("winmm.dll")]
        public static extern uint joyGetPosEx(uint joyId, ref JOYINFOEX info);

        /// <summary>A joystick's name, axis ranges and capabilities.</summary>
        [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "joyGetDevCapsW")]
        public static extern uint joyGetDevCaps(nuint joyId, ref JOYCAPSW caps, uint size);
    }
}
