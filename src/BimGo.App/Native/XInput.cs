using System.Runtime.InteropServices;

// The class belongs to the Native namespace
namespace BimGo.Native
{
    /// <summary>
    /// Hand-written XInput interop (input round B2, build B): <c>xinput1_4.dll</c> ships with Windows 8 and later, so
    /// there is no package. Only the state read; no vibration.
    /// </summary>
    internal static class XInput
    {
        /// <summary>Controllers XInput can report (user indices 0–3).</summary>
        public const int MAX_CONTROLLERS = 4;

        public const uint ERROR_SUCCESS = 0;

        // wButtons bits
        public const ushort DPAD_UP = 0x0001, DPAD_DOWN = 0x0002, DPAD_LEFT = 0x0004, DPAD_RIGHT = 0x0008;
        public const ushort START = 0x0010, BACK = 0x0020, LEFT_THUMB = 0x0040, RIGHT_THUMB = 0x0080;
        public const ushort LEFT_SHOULDER = 0x0100, RIGHT_SHOULDER = 0x0200;
        public const ushort A = 0x1000, B = 0x2000, X = 0x4000, Y = 0x8000;

        /// <summary>XINPUT_GAMEPAD.</summary>
        [StructLayout(LayoutKind.Sequential)]
        public struct GAMEPAD
        {
            public ushort wButtons;
            public byte bLeftTrigger;
            public byte bRightTrigger;
            public short sThumbLX;
            public short sThumbLY;
            public short sThumbRX;
            public short sThumbRY;
        }

        /// <summary>XINPUT_STATE.</summary>
        [StructLayout(LayoutKind.Sequential)]
        public struct STATE
        {
            public uint dwPacketNumber;
            public GAMEPAD Gamepad;
        }

        /// <summary>Reads one controller (ERROR_SUCCESS, or ERROR_DEVICE_NOT_CONNECTED = 1167).</summary>
        [DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")]
        public static extern uint GetState(uint userIndex, out STATE state);
    }
}
