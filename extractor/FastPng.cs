using System.IO.Compression;

/// <summary>Writes 8-bit RGBA or 16-bit grayscale pixels as a PNG without filtering and with fast deflate.</summary>
static class FastPng
{
    // CRC-32 of the PNG chunks, eight bytes at a time (slicing-by-8).
    static readonly uint[][] Tables = MakeTables();
    static uint[][] MakeTables()
    {
        var t = new uint[8][];
        t[0] = new uint[256];
        for (uint n = 0; n < 256; n++) { uint c = n; for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1; t[0][n] = c; }
        for (int i = 1; i < 8; i++)
        {
            t[i] = new uint[256];
            for (int n = 0; n < 256; n++) t[i][n] = (t[i - 1][n] >> 8) ^ t[0][t[i - 1][n] & 0xFF];
        }
        return t;
    }
    static uint Crc(uint crc, ReadOnlySpan<byte> data)
    {
        var t = Tables;
        int i = 0;
        for (; i + 8 <= data.Length; i += 8)
        {
            uint a = crc ^ System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(data[i..]);
            uint b = System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(data[(i + 4)..]);
            crc = t[7][a & 0xFF] ^ t[6][(a >> 8) & 0xFF] ^ t[5][(a >> 16) & 0xFF] ^ t[4][a >> 24] ^ t[3][b & 0xFF] ^ t[2][(b >> 8) & 0xFF] ^ t[1][(b >> 16) & 0xFF] ^ t[0][b >> 24];
        }
        for (; i < data.Length; i++) crc = t[0][(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
        return crc;
    }

    static void Chunk(Stream o, string type, ReadOnlySpan<byte> data)
    {
        Span<byte> head = stackalloc byte[8];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(head, (uint)data.Length);
        for (int i = 0; i < 4; i++) head[4 + i] = (byte)type[i];
        o.Write(head);
        o.Write(data);
        uint crc = Crc(Crc(0xFFFFFFFF, head[4..]), data) ^ 0xFFFFFFFF;
        Span<byte> tail = stackalloc byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(tail, crc);
        o.Write(tail);
    }

    // Collects what the compressor writes and emits it as IDAT chunks of at most 8 MB.
    sealed class IdatStream : Stream
    {
        readonly Stream _out; readonly byte[] _buf = new byte[8 << 20]; int _n;
        public IdatStream(Stream o) { _out = o; }
        public override void Write(byte[] b, int o, int c) => Write(b.AsSpan(o, c));
        public override void Write(ReadOnlySpan<byte> s)
        {
            while (s.Length > 0) { int take = Math.Min(s.Length, _buf.Length - _n); s[..take].CopyTo(_buf.AsSpan(_n)); _n += take; s = s[take..]; if (_n == _buf.Length) Emit(); }
        }
        void Emit() { if (_n > 0) { Chunk(_out, "IDAT", _buf.AsSpan(0, _n)); _n = 0; } }
        public void Finish() => Emit();
        public override void Flush() { }
        public override bool CanRead => false; public override bool CanSeek => false; public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] b, int o, int c) => throw new NotSupportedException(); public override long Seek(long o, SeekOrigin r) => throw new NotSupportedException(); public override void SetLength(long v) => throw new NotSupportedException();
    }

    /// <param name="bytesPerPixel">4 for RGBA (bit depth 8), 2 for grayscale (bit depth 16, samples little-endian in <paramref name="data"/>).</param>
    /// <param name="swapRedBlue">The data is BGRA.</param>
    public static void Write(string path, byte[] data, int width, int height, int bytesPerPixel, bool swapRedBlue, CompressionLevel level)
    {
        using var file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20);
        file.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });
        var ihdr = new byte[13];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(ihdr, (uint)width);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(ihdr.AsSpan(4), (uint)height);
        ihdr[8] = (byte)(bytesPerPixel == 4 ? 8 : 16);
        ihdr[9] = (byte)(bytesPerPixel == 4 ? 6 : 0);
        Chunk(file, "IHDR", ihdr);
        var idat = new IdatStream(file);
        using (var z = new ZLibStream(idat, level, leaveOpen: true))
        {
            int stride = width * bytesPerPixel;
            var row = new byte[stride + 1];   // the first byte is the filter type, 0 = none
            for (int y = 0; y < height; y++)
            {
                var src = data.AsSpan(y * stride, stride);
                if (bytesPerPixel == 4 && swapRedBlue) { for (int x = 0; x < stride; x += 4) { row[1 + x] = src[x + 2]; row[2 + x] = src[x + 1]; row[3 + x] = src[x]; row[4 + x] = src[x + 3]; } }
                else if (bytesPerPixel == 2) { for (int x = 0; x < stride; x += 2) { row[1 + x] = src[x + 1]; row[2 + x] = src[x]; } }
                else src.CopyTo(row.AsSpan(1));
                z.Write(row);
            }
        }
        idat.Finish();
        Chunk(file, "IEND", ReadOnlySpan<byte>.Empty);
    }
}
