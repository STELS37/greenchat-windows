import { type Metafile } from "esbuild";

export const WEB_SPLIT_OPTIONS: Readonly<{
  format: "esm";
  splitting: true;
  chunkNames: string;
}>;

export function outputDependency(
  outputs: Metafile["outputs"],
  owner: string,
  dependency: string,
): string;

export function collectStaticOutputs(
  outputs: Metafile["outputs"],
  entry: string,
): Set<string>;
