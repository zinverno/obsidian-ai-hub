import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// manifest.json: версия из package.json, minAppVersion не трогаем
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// versions.json: новая запись версия → текущий minAppVersion
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
