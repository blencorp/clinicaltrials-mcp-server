import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractZipEntryBuffer } from "../scripts/mcpb.js";

function createZipWithEntry(
  entryName: string,
  content: Buffer,
  compressionMethod: 0 | 8,
): Buffer {
  const fileName = Buffer.from(entryName, "utf8");
  const payload = compressionMethod === 0 ? content : deflateRawSync(content);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(compressionMethod, 8);
  localHeader.writeUInt32LE(0, 14);
  localHeader.writeUInt32LE(payload.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(fileName.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const localRecord = Buffer.concat([localHeader, fileName, payload]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(compressionMethod, 10);
  centralHeader.writeUInt32LE(0, 16);
  centralHeader.writeUInt32LE(payload.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(fileName.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const centralRecord = Buffer.concat([centralHeader, fileName]);

  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(1, 8);
  endOfCentralDirectory.writeUInt16LE(1, 10);
  endOfCentralDirectory.writeUInt32LE(centralRecord.length, 12);
  endOfCentralDirectory.writeUInt32LE(localRecord.length, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([localRecord, centralRecord, endOfCentralDirectory]);
}

describe("extractZipEntryBuffer", () => {
  it("extracts stored entries", () => {
    const expected = Buffer.from("hello world", "utf8");
    const zipBuffer = createZipWithEntry("deno.exe", expected, 0);

    expect(extractZipEntryBuffer(zipBuffer, "deno.exe")).toEqual(expected);
  });

  it("extracts deflated entries", () => {
    const expected = Buffer.from("compressed binary payload", "utf8");
    const zipBuffer = createZipWithEntry("deno", expected, 8);

    expect(extractZipEntryBuffer(zipBuffer, "deno")).toEqual(expected);
  });
});
