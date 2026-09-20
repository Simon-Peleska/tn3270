{
  description = "Web TN3270 terminal: b3270 backend, ghostty-web frontend";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (
        pkgs:
        {
          b3270 = pkgs.callPackage ./nix/b3270.nix { };
          default = self.packages.${pkgs.stdenv.hostPlatform.system}.b3270;
        }
        // nixpkgs.lib.optionalAttrs (pkgs.stdenv.hostPlatform.system == "x86_64-linux") {
          # Cross-compiled; Nix cannot run a Windows build itself.
          b3270-windows = pkgs.pkgsCross.mingwW64.callPackage ./nix/b3270.nix { };
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.typescript
            pkgs.python3
            self.packages.${pkgs.stdenv.hostPlatform.system}.b3270
          ];

          shellHook = ''
            echo "tn3270 dev shell"
            echo "  node    $(node --version)"
            echo "  b3270   $(b3270 --version 2>&1 | head -1)"
            echo "  s3270   $(s3270 --version 2>&1 | head -1)"
          '';
        };
      });
    };
}
