{
  lib,
  stdenv,
  fetchurl,
  m4,
  python3,
  expat,
  openssl,
}:

# The nixpkgs `x3270` package builds the whole suite, which drags in all of X11.
# We only ever run the headless back ends, so build just those. Note that
# `--enable-b3270` alone is not enough: suite3270's configure enables every
# component by default, so the unwanted ones must be turned off explicitly or
# it fails looking for X (or, on Windows, for the interactive wc3270 client).
# pr3287 and x3270if stay on because the b3270 build and install targets
# depend on them. s3270 is headless too, and is the oracle the REST proxy's
# comparison test measures itself against; the Windows build has no such test
# to run, so it is left out of the cross build.
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

    # The Windows half of configure.in expects to run inside an MSYS2/mingw
    # shell, where the bare names "gcc", "gcc-ar" and "windres" already mean
    # the right cross tools. Nix's mingw toolchain only exposes triple-prefixed
    # names, so hand it a PATH where the short names resolve to them too.
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

    # The build stamps a human-readable date into version.c; the bare epoch that
    # nixpkgs sets is not in the format it expects.
    preBuild = ''
      if [ -n "$SOURCE_DATE_EPOCH" ]; then
        export SOURCE_DATE_EPOCH="$(date -u -d "@$SOURCE_DATE_EPOCH" '+%a %b %d %H:%M:%S UTC %Y')"
      fi
    '';

    # `b3270-install` also installs pr3287 and x3270if, which the b3270 target
    # depends on. They are small and pull in no extra libraries. Windows has no
    # such install target at all - "make b3270" there just drops the .exe in
    # place, so it is copied out by hand.
    #
    # Naming the targets rather than "make all" keeps the unbuilt components
    # out of it: configure only disabled them, the top-level target still
    # descends into every directory it knows about.
    #
    # One target per make run, though, never "make b3270 s3270": both goals
    # descend into the same lib/3270 and lib/32xx, as separate sub-makes that
    # know nothing of each other, and under -j that is two `ar` runs over one
    # archive. CI caught it as "lib3270.a: error reading telnet_sio.o: file
    # truncated". Inside a single goal -j is fine, which is why the shared
    # libraries are already built by the time s3270 links.
    buildFlags = [ "b3270" ];

    postBuild = lib.optionalString (!isWindows) ''
      make -j$NIX_BUILD_CORES s3270
    '';

    enableParallelBuilding = true;

    # Both install targets install pr3287 and x3270if, and two `install -c` runs
    # racing over the same path fail outright rather than one winning.
    enableParallelInstalling = false;

    nativeBuildInputs = [
      m4
      python3
    ];

    # Windows TLS goes through the native SChannel/CryptoAPI libraries that
    # mingw already links (crypt32, secur32), and its libexpat is vendored and
    # built from source by the suite's own Makefile - so neither dependency
    # applies there.
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
