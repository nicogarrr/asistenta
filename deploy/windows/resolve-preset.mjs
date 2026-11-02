// Preset efectivo del modelo para el arranque de Windows (run-stack.ps1 → Get-ProviderPreset),
// con las mismas reglas que el instalador y Asistenta: variable del sistema, luego el archivo de
// configuración de la carpeta (la última línea gana), vacío = «opencode», sin mayúsculas.
// Se ejecuta con la carpeta de la app como directorio de trabajo. Solo imprime el preset.
import { envText, presetFromEnv } from '../../scripts/instalar.mjs';

process.stdout.write(presetFromEnv(envText(), process.env));
