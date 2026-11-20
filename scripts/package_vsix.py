#!/usr/bin/env python3
"""Build a local VSIX from an explicit list of extension runtime files."""

import json
import os
from pathlib import Path
import tempfile
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parent.parent
FILES = (
    "package.json",
    "README.md",
    "assets/flow-graph.svg",
    "assets/flow-graph.png",
    "assets/gutter.svg",
    "grammars/tree-sitter-c.wasm",
    "grammars/tree-sitter-rust.wasm",
    "vendor/web-tree-sitter/tree-sitter.cjs",
    "vendor/web-tree-sitter/tree-sitter.wasm",
    "third_party/README.md",
    "third_party/tree-sitter-c-LICENSE",
    "third_party/tree-sitter-rust-LICENSE",
    "third_party/tree-sitter-wasms-LICENSE",
    "third_party/web-tree-sitter-LICENSE",
    "src/anchor.js",
    "src/decorations.js",
    "src/extension.js",
    "src/graph.js",
    "src/naming.js",
    "src/note-text.js",
    "src/persistence.js",
    "src/tree.js",
)

VSIX_NS = "http://schemas.microsoft.com/developer/vsx-schema/2011"
CONTENT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
ET.register_namespace("", VSIX_NS)


def element(parent, name, text=None, **attributes):
    child = ET.SubElement(parent, f"{{{VSIX_NS}}}{name}", attributes)
    if text is not None:
        child.text = text
    return child


def manifest_xml(package):
    root = ET.Element(f"{{{VSIX_NS}}}PackageManifest", Version="2.0.0")
    metadata = element(root, "Metadata")
    element(metadata, "Identity", Language="en-US", Id=package["name"],
            Version=package["version"], Publisher=package["publisher"])
    element(metadata, "DisplayName", package.get("displayName", package["name"]))
    element(metadata, "Description", package.get("description", ""))
    element(metadata, "Tags", ",".join(package.get("keywords", [])))
    element(metadata, "Categories", ",".join(package.get("categories", [])))
    element(metadata, "GalleryFlags", "Public")
    properties = element(metadata, "Properties")
    values = {
        "Engine": package["engines"]["vscode"],
        "ExtensionDependencies": "",
        "ExtensionPack": "",
        "ExtensionKind": "workspace",
        "LocalizedLanguages": "",
        "EnabledApiProposals": "",
        "ExecutesCode": "true",
        "Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown": "true",
    }
    for key, value in values.items():
        property_id = key if key.startswith("Microsoft.") else f"Microsoft.VisualStudio.Code.{key}"
        element(properties, "Property", Id=property_id, Value=value)
    installation = element(root, "Installation")
    element(installation, "InstallationTarget", Id="Microsoft.VisualStudio.Code")
    element(root, "Dependencies")
    assets = element(root, "Assets")
    element(assets, "Asset", Type="Microsoft.VisualStudio.Code.Manifest",
            Path="extension/package.json", Addressable="true")
    element(assets, "Asset", Type="Microsoft.VisualStudio.Services.Content.Details",
            Path="extension/readme.md", Addressable="true")
    if package.get("icon"):
        icon_path = f'extension/{package["icon"]}'
        element(metadata, "Icon", icon_path)
        element(assets, "Asset", Type="Microsoft.VisualStudio.Services.Icons.Default",
                Path=icon_path, Addressable="true")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def content_types_xml():
    content_types = {
        ".vsixmanifest": "text/xml",
        ".json": "application/json",
        ".md": "text/markdown",
        ".js": "application/javascript",
        ".cjs": "application/javascript",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".wasm": "application/wasm",
    }
    root = ET.Element(f"{{{CONTENT_NS}}}Types")
    for extension, content_type in sorted(content_types.items()):
        ET.SubElement(root, f"{{{CONTENT_NS}}}Default", Extension=extension,
                      ContentType=content_type)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def build():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    if package.get("main") != "./src/extension.js":
        raise ValueError("Unexpected extension entrypoint")
    if package.get("icon") != "assets/flow-graph.png":
        raise ValueError("Unexpected extension icon path")
    for key in ("name", "publisher", "version"):
        value = package[key]
        if not isinstance(value, str) or not value or not all(
                char.isalnum() or char in "-." for char in value):
            raise ValueError(f"Unsafe {key}")
    output_dir = ROOT / "dist"
    if output_dir.is_symlink():
        raise ValueError("Unsafe output directory")
    output_dir.mkdir(exist_ok=True)
    destination = output_dir / f'{package["publisher"]}.{package["name"]}-{package["version"]}.vsix'
    staged = tempfile.NamedTemporaryFile(prefix=".vsix-", suffix=".tmp", dir=output_dir,
                                         delete=False)
    temporary = Path(staged.name)
    staged.close()
    try:
        expected = {"[Content_Types].xml", "extension.vsixmanifest"}
        total_bytes = 0
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED,
                             compresslevel=6) as archive:
            archive.writestr("[Content_Types].xml", content_types_xml())
            archive.writestr("extension.vsixmanifest", manifest_xml(package))
            for relative in FILES:
                path = Path(relative)
                if path.is_absolute() or ".." in path.parts:
                    raise ValueError(f"Unsafe archive path: {relative}")
                source = ROOT / path
                if source.is_symlink() or not source.is_file() or any(
                        ancestor.is_symlink() for ancestor in source.parents if ancestor != ROOT):
                    raise ValueError(f"Missing or unsafe runtime file: {relative}")
                try:
                    source.resolve(strict=True).relative_to(ROOT.resolve())
                except ValueError as error:
                    raise ValueError(f"Runtime file escapes extension root: {relative}") from error
                size = source.stat().st_size
                if size > 3_000_000:
                    raise ValueError(f"Unexpectedly large runtime file: {relative}")
                total_bytes += size
                if total_bytes > 8_000_000:
                    raise ValueError("Runtime payload exceeds size limit")
                target = f'extension/{"readme.md" if relative == "README.md" else relative}'
                expected.add(target)
                archive.write(source, arcname=target)
        with zipfile.ZipFile(temporary) as archive:
            if set(archive.namelist()) != expected or archive.testzip() is not None:
                raise ValueError("VSIX failed the content allowlist or CRC validation")
            ET.fromstring(archive.read("extension.vsixmanifest"))
            ET.fromstring(archive.read("[Content_Types].xml"))
        os.replace(temporary, destination)
        destination.chmod(0o644)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


if __name__ == "__main__":
    print(build())
