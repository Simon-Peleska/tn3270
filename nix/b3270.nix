{
  lib,
  stdenv,
  fetchurl,
  m4,
  python3,
  expat,
  openssl,
}:

# Headless back ends only. Every unwanted component needs an explicit
# --disable: configure enables all of them and then goes looking for X11.
let
  isWindows = stdenv.hostPlatform.isWindows;
in
stdenv.mkDerivation (
  finalAttrs:
  {
    pname = "b3270";
    version = "4.5ga5";

    src = fetchurl {
      url = "https://x3270.bgp.nu/download/04.05/suite3270-${finalAttrs.version}-src.tgz";
      hash = "sha256-AVdvpYWYzN09Nm/r+u9h49Hek+tgqT+axrpfr4QUTG8=";
    };

    postPatch = ''
      patchShebangs .
      substituteInPlace Common/mkversion.py \
        --replace-fail "int(os.environ['SOURCE_DATE_EPOCH'])" "1"
    '';

    # configure.in's Windows half expects MSYS2, where bare "gcc"/"gcc-ar"/"windres"
    # are the cross tools; Nix's mingw exposes only triple-prefixed names.
    preConfigure = lib.optionalString isWindows ''
      mkdir -p .nix-windows-tools
      ln -s "${stdenv.cc}/bin/${stdenv.cc.targetPrefix}gcc" .nix-windows-tools/gcc
      ln -s "${stdenv.cc.cc}/bin/${stdenv.cc.targetPrefix}gcc-ar" .nix-windows-tools/gcc-ar
      ln -s "${stdenv.cc.bintools.bintools}/bin/${stdenv.cc.targetPrefix}windres" .nix-windows-tools/windres
      export PATH="$PWD/.nix-windows-tools:$PATH"
    '';

    configureFlags = [
      "--enable-b3270"
      "--enable-pr3287"
      "--enable-x3270if"
      "--disable-x3270"
      "--disable-c3270"
      "--disable-tcl3270"
      "--disable-wc3270"
    ]
    ++ (if isWindows then [ "--disable-s3270" ] else [ "--enable-s3270" ]);

    # version.c wants a human-readable date, not the bare epoch nixpkgs sets.
    preBuild = ''
      if [ -n "$SOURCE_DATE_EPOCH" ]; then
        export SOURCE_DATE_EPOCH="$(date -u -d "@$SOURCE_DATE_EPOCH" '+%a %b %d %H:%M:%S UTC %Y')"
      fi
    '';

    # One goal per make run, never "make b3270 s3270": both descend into the same
    # lib/3270 as unrelated sub-makes, which under -j is two `ar` runs on one archive.
    buildFlags = [ "b3270" ];

    postBuild = lib.optionalString (!isWindows) ''
      make -j$NIX_BUILD_CORES s3270
    '';

    enableParallelBuilding = true;

    # Both install targets install pr3287 and x3270if; two `install -c` runs on
    # one path fail outright rather than one winning.
    enableParallelInstalling = false;

    nativeBuildInputs = [
      m4
      python3
    ];

    # Windows uses the SChannel libraries mingw already links, and vendors expat.
    buildInputs = lib.optionals (!isWindows) [
      expat
      openssl
    ];

    meta = {
      description = "Headless back ends of the x3270 IBM 3270 terminal emulator suite";
      homepage = "https://x3270.bgp.nu/";
      license = lib.licenses.bsd3;
      mainProgram = if isWindows then "b3270.exe" else "b3270";
      platforms = if isWindows then lib.platforms.windows else lib.platforms.unix;
    };
  }
  // (
    if isWindows then
      {
        installPhase = ''
          runHook preInstall
          mkdir -p $out/bin
          cp obj/x86_64-w64-mingw32/b3270/b3270.exe $out/bin/
          runHook postInstall
        '';
      }
    else
      {
        installTargets = [
          "b3270-install"
          "s3270-install"
        ];
      }
  )
)
