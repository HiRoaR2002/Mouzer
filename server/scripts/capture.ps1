<#
    Mouzer screen-capture worker (Windows).

    The capture loop runs as embedded C# rather than in PowerShell on purpose:
    a PowerShell loop pays interpreter overhead on every single frame, while the
    C# loop is a tight GDI+ copy + JPEG encode. Same process, same permissions,
    roughly an order of magnitude less CPU per frame.

    IMPORTANT: the C# below is compiled by Add-Type. Under Windows PowerShell 5.1
    that is the CodeDom compiler, which only understands C# 5. No string
    interpolation, no '?.', no 'out var', no expression-bodied members.

    Two modes:
      -Probe  Print a JSON description of the attached displays, then exit.
      default Run the capture loop. Frames go to stdout as
             [uint32 big-endian length][JPEG bytes] so the parent can frame
             them without scanning for JPEG markers. Human-readable diagnostics
             go to stderr, keeping stdout a pure binary channel.
             Settings can be retuned live by writing "k=v k=v" lines to stdin.
#>

param(
    [int]    $Monitor = 0,
    [int]    $Scale   = 100,
    [int]    $Quality = 55,
    [int]    $Fps     = 12,
    [switch] $Probe
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$csharp = @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Threading;
using System.Windows.Forms;

public static class MouzerCapture
{
    private static volatile int vFps = 12;
    private static volatile int vScale = 100;
    private static volatile int vQuality = 55;
    private static volatile int vMonitor = 0;
    private static volatile bool vRunning = true;

    private static int Clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

    private static void ReadSettings(StreamReader reader)
    {
        string line;
        while (vRunning && (line = reader.ReadLine()) != null)
        {
            string[] parts = line.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string part in parts)
            {
                int eq = part.IndexOf('=');
                if (eq <= 0) continue;
                string k = part.Substring(0, eq);
                int v;
                if (!int.TryParse(part.Substring(eq + 1), out v)) continue;
                if (k == "fps") vFps = Clamp(v, 1, 60);
                else if (k == "scale") vScale = Clamp(v, 10, 100);
                else if (k == "quality") vQuality = Clamp(v, 10, 95);
                else if (k == "monitor") vMonitor = v;
                else if (k == "stop") vRunning = false;
            }
        }
    }

    public static void Run(Stream stdout, StreamReader stdin, int monitor, int scale, int quality, int fps)
    {
        vMonitor = monitor;
        vScale = scale;
        vQuality = quality;
        vFps = Clamp(fps, 1, 60);

        Thread settings = new Thread(delegate() { ReadSettings(stdin); });
        settings.IsBackground = true;
        settings.Start();

        Screen[] screens = Screen.AllScreens;
        if (screens.Length == 0)
        {
            Console.Error.WriteLine("FATAL: no displays reported by the OS");
            return;
        }

        ImageCodecInfo codec = null;
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
        {
            if (c.FormatID == System.Drawing.Imaging.ImageFormat.Jpeg.Guid) { codec = c; break; }
        }
        if (codec == null)
        {
            Console.Error.WriteLine("FATAL: no JPEG encoder available in System.Drawing");
            return;
        }

        Console.Error.WriteLine("READY screens=" + screens.Length + " primary=" +
            Screen.PrimaryScreen.Bounds.Width + "x" + Screen.PrimaryScreen.Bounds.Height);

        Stopwatch clock = Stopwatch.StartNew();

        // Bitmaps and encoder params are cached: reallocating them every frame
        // churns GDI handles for no benefit when only the pixels changed.
        Bitmap cached = null;
        Graphics gfx = null;
        int cachedW = -1, cachedH = -1;
        EncoderParameters cachedEnc = null;
        int cachedQ = -1;
        byte[] header = new byte[4];
        int errors = 0;
        long due = 0;

        while (vRunning)
        {
            try
            {
                int mon = Clamp(vMonitor, 0, screens.Length - 1);
                Rectangle box = screens[mon].Bounds;
                int sc = Clamp(vScale, 10, 100);
                int q  = Clamp(vQuality, 10, 95);
                int dw = Math.Max(160, box.Width * sc / 100);
                int dh = Math.Max(120, box.Height * sc / 100);

                if (cached == null || dw != cachedW || dh != cachedH)
                {
                    if (gfx != null) gfx.Dispose();
                    if (cached != null) cached.Dispose();
                    cached = new Bitmap(dw, dh);
                    gfx = Graphics.FromImage(cached);
                    gfx.InterpolationMode = InterpolationMode.Bilinear;
                    gfx.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    gfx.SmoothingMode = SmoothingMode.HighQuality;
                    cachedW = dw;
                    cachedH = dh;
                }
                if (q != cachedQ)
                {
                    if (cachedEnc != null) cachedEnc.Dispose();
                    cachedEnc = new EncoderParameters(1);
                    cachedEnc.Param[0] = new EncoderParameter(Encoder.Quality, (long)q);
                    cachedQ = q;
                }

                // Single CopyFromScreen with an explicit destination size both
                // grabs the pixels and downscales them, so we never pay for
                // capturing at full resolution and resizing afterwards.
                gfx.CopyFromScreen(box.X, box.Y, 0, 0, new Size(dw, dh), CopyPixelOperation.SourceCopy);

                using (MemoryStream ms = new MemoryStream(1 << 20))
                {
                    cached.Save(ms, codec, cachedEnc);
                    byte[] bytes = ms.ToArray();
                    uint len = (uint)bytes.Length;
                    header[0] = (byte)(len >> 24);
                    header[1] = (byte)(len >> 16);
                    header[2] = (byte)(len >> 8);
                    header[3] = (byte)len;
                    stdout.Write(header, 0, 4);
                    stdout.Write(bytes, 0, bytes.Length);
                    stdout.Flush();
                }
                errors = 0;
            }
            catch (Exception ex)
            {
                errors++;
                if (errors == 1 || errors % 30 == 0)
                {
                    Console.Error.WriteLine("CAPTURE_ERROR(" + errors + "): " +
                        ex.GetType().Name + ": " + ex.Message);
                }
            }

            due += 1000 / Clamp(vFps, 1, 60);
            int sleep = (int)(due - clock.ElapsedMilliseconds);
            if (sleep > 0) Thread.Sleep(sleep);
            else due = clock.ElapsedMilliseconds;   // we are behind schedule; don't accumulate debt
        }

        if (gfx != null) gfx.Dispose();
        if (cached != null) cached.Dispose();
        if (cachedEnc != null) cachedEnc.Dispose();
    }
}
'@

Add-Type -TypeDefinition $csharp -ReferencedAssemblies 'System.Drawing.dll', 'System.Windows.Forms.dll'

if ($Probe) {
    $list = @()
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
        $list += [ordered]@{
            name     = $s.DeviceName
            primary  = [bool]$s.Primary
            x        = [int]$s.Bounds.X
            y        = [int]$s.Bounds.Y
            width    = [int]$s.Bounds.Width
            height   = [int]$s.Bounds.Height
        }
    }
    # The numeric -f argument selects an entry from Screen.AllScreens, so the
    # index has to follow that exact ordering.
    for ($i = 0; $i -lt $list.Count; $i++) { $list[$i] = [ordered]@{ index = $i } + $list[$i] }
    [ordered]@{
        os        = 'windows'
        backend   = 'powershell'
        displays  = @($list)
    } | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

$stdout = [Console]::OpenStandardOutput()
$stdin  = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
[MouzerCapture]::Run($stdout, $stdin, $Monitor, $Scale, $Quality, $Fps)
