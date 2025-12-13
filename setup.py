from setuptools import setup, find_packages

setup(
    name="beepm",
    version="0.1.0",
    packages=find_packages(),
    include_package_data=True,
    install_requires=[
        "click>=8.1.0",
        "requests>=2.31.0",
        "configparser>=6.0.0",
        "srctools>=2.0.0",
    ],
    entry_points={
        "console_scripts": [
            "beepm=beepm.cli:cli",
        ],
    },
    author="BeePM",
    description="BEE2 Package Manager - A CLI tool for managing BEE2 packages",
    python_requires=">=3.7",
)

