# installer

Los instaladores de upstream (`install.bat`, `install.command`, `tv-install.sh`,
`tv-install-earc.sh`) se han retirado: descargaban un `.ipk` prefabricado de terceros
y lo ejecutaban como root con `curl | ssh`. Aqui solo queda `tv-uninstall.sh`
(local) y `RUNBOOK_ES.md` (instalacion del build propio, en ventana de Nico).
