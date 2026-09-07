{
  lib,
  stdenv,
  fetchurl,
  m4,
  python3,
  expat,
  openssl,
  libiconv,
}:

# The nixpkgs `x3270` package builds the whole suite, which drags in all of X11.
# We only ever run the headless back end, so build just that. Note that
# `--enable-b3270` alone is not enough: suite3270's configure enables every
# component by default, so the unwanted ones must be turned off explicitly or
# it fails looking for X. pr3287 and x3270if stay on because the b3270 build
# and install targets depend on them.
stdenv.mkDerivation (finalAttrs: {
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

  configureFlags = [
    "--enable-b3270"
    "--enable-pr3287"
    "--enable-x3270if"
    "--disable-x3270"
    "--disable-c3270"
    "--disable-s3270"
    "--disable-tcl3270"
  ];

  # The build stamps a human-readable date into version.c; the bare epoch that
  # nixpkgs sets is not in the format it expects.
  preBuild = ''
    if [ -n "$SOURCE_DATE_EPOCH" ]; then
      export SOURCE_DATE_EPOCH="$(date -u -d "@$SOURCE_DATE_EPOCH" '+%a %b %d %H:%M:%S UTC %Y')"
    fi
  '';

  # `b3270-install` also installs pr3287 and x3270if, which the b3270 target
  # depends on. They are small and pull in no extra libraries.
  buildFlags = [ "b3270" ];
  installTargets = [ "b3270-install" ];

  enableParallelBuilding = true;

  nativeBuildInputs = [
    m4
    python3
  ];

  buildInputs = [
    expat
    openssl
  ]
  ++ lib.optional stdenv.hostPlatform.isDarwin libiconv;

  meta = {
    description = "Headless back end of the x3270 IBM 3270 terminal emulator suite";
    homepage = "https://x3270.bgp.nu/";
    license = lib.licenses.bsd3;
    mainProgram = "b3270";
    platforms = lib.platforms.unix;
  };
})
