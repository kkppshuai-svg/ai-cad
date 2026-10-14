"""Create the assembly ZIP with Python's standard library on Windows/Linux."""
from pathlib import Path
import sys
from zipfile import ZipFile, ZIP_DEFLATED


def package_archive(directory, destination):
    root = Path(directory).resolve()
    package = root / "assembly_kinematic_package"
    if not package.is_dir():
        raise ValueError("Assembly package directory does not exist")
    with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
        for file in sorted(package.rglob("*")):
            if file.is_file():
                archive.write(file, file.relative_to(root).as_posix())


if __name__ == "__main__":
    package_archive(sys.argv[1], sys.argv[2])
