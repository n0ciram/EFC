# EFC — Arranque alternativo del ayudante del Explorador.
#
# Se usa solo si no existe el ejecutable compilado (efc-helper.exe). Compila en memoria el mismo
# código C# (EfcHelper.cs) con Add-Type y ejecuta su bucle de peticiones por la entrada estándar.
# No lee ni ejecuta nada que provenga de los archivos del usuario.
param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath
)

$ErrorActionPreference = 'Stop'
$source = [System.IO.File]::ReadAllText($SourcePath)

function New-CompilerParameters([string[]]$References, [string]$Defines) {
    $parameters = New-Object System.CodeDom.Compiler.CompilerParameters
    $parameters.GenerateInMemory = $true
    $parameters.GenerateExecutable = $false
    [void]$parameters.ReferencedAssemblies.Add('System.dll')
    foreach ($reference in $References) { [void]$parameters.ReferencedAssemblies.Add($reference) }
    $parameters.CompilerOptions = $Defines
    return $parameters
}

$compiled = $false
try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
    $references = @(
        [System.Windows.Automation.AutomationElement].Assembly.Location,
        [System.Windows.Automation.ControlType].Assembly.Location,
        [System.Windows.Rect].Assembly.Location
    )
    Add-Type -TypeDefinition $source -Language CSharp -CompilerParameters (New-CompilerParameters $references '/define:EFC_UIA')
    $compiled = $true
} catch {
    [Console]::Error.WriteLine("EFC: compilación con UI Automation no disponible: $($_.Exception.Message)")
}

if (-not $compiled) {
    Add-Type -TypeDefinition $source -Language CSharp -CompilerParameters (New-CompilerParameters @() '')
}

exit [EfcHelper.Program]::Run()
