// Local route fixture: isolate the existing PDF parser, keep extraction and all writes real.
export default async function parse(buffer: Buffer) { return { text: buffer.toString("utf8") }; }
