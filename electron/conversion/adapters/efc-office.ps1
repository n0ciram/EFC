# EFC — Documentos de Office a PDF con el propio Microsoft Office (automatización COM).
#
# Lo ejecuta el proceso de conversión de EFC (adapters/office.ts), un documento cada vez. Los datos
# llegan por variables de entorno, así las rutas no tienen problemas de comillas:
#   EFC_OFFICE_APP  word | excel | powerpoint
#   EFC_OFFICE_IN   documento de origen (se abre solo para lectura)
#   EFC_OFFICE_OUT  PDF que hay que crear
# Escribe en la salida estándar una línea JSON por evento:
#   {"event":"started","pids":[…]}   procesos de Office abiertos por este script (para cerrarlos si se cuelga)
#   {"event":"done"}                 PDF creado
#   {"event":"error","stage":…,"hresult":…,"detail":…}   stage: start, open, export o empty (libro vacío)
#   {"event":"warning","stage":…,"detail":…}             problemas al cerrar Office (solo para el registro)
#
# Seguridad: las macros se desactivan antes de abrir nada (AutomationSecurity = ForceDisable), no se
# actualizan vínculos externos, el documento no se añade a «Recientes» y nunca se guarda. Una
# contraseña ficticia hace que un documento protegido dé error en vez de mostrar un diálogo oculto.
#
# Todas las llamadas usan IDispatch (InvokeMember): con Office de 32 bits y PowerShell de 64 bits, la
# biblioteca de tipos suele estar registrada solo para 32 bits y el acceso normal falla
# (TYPE_E_CANTLOADLIBRARY).

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$App = $env:EFC_OFFICE_APP
$InputPath = $env:EFC_OFFICE_IN
$OutputPath = $env:EFC_OFFICE_OUT
$DummyPassword = 'efc-sin-contraseña'

function Send-Event([hashtable]$Data) {
    [Console]::Out.WriteLine(($Data | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

# La coma evita que PowerShell «desenrolle» las colecciones (Documents, Workbooks…) al devolverlas.
function Get-ComProperty($Object, [string]$Name) {
    return , $Object.GetType().InvokeMember($Name, [Reflection.BindingFlags]::GetProperty, $null, $Object, $null)
}

function Set-ComProperty($Object, [string]$Name, $Value) {
    [void]$Object.GetType().InvokeMember($Name, [Reflection.BindingFlags]::SetProperty, $null, $Object, @($Value))
}

# Argumentos con nombre: los opcionales que no se indican toman el valor por defecto de Office.
function Invoke-ComMethod($Object, [string]$Name, [System.Collections.Specialized.OrderedDictionary]$Named) {
    if (-not $Named -or $Named.Count -eq 0) {
        return , $Object.GetType().InvokeMember($Name, [Reflection.BindingFlags]::InvokeMethod, $null, $Object, $null)
    }
    $names = [string[]]@($Named.Keys)
    # Sin el envoltorio de PowerShell (PSObject): COM lo rechazaría con DISP_E_TYPEMISMATCH.
    $values = [object[]]@($Named.Values | ForEach-Object { $_.PSObject.BaseObject })
    return , $Object.GetType().InvokeMember($Name, [Reflection.BindingFlags]::InvokeMethod, $null, $Object, $values, $null, $null, $names)
}

function Get-ComItem($Collection, [int]$Index) {
    return , $Collection.GetType().InvokeMember('Item', [Reflection.BindingFlags]::GetProperty, $null, $Collection, @($Index))
}

# Excel no exporta un libro sin nada que imprimir: se distingue para dar un aviso claro.
function Test-ExcelEmpty($Office, $Book) {
    if ([int](Get-ComProperty (Get-ComProperty $Book 'Charts') 'Count') -gt 0) { return $false }
    $functions = Get-ComProperty $Office 'WorksheetFunction'
    $sheets = Get-ComProperty $Book 'Worksheets'
    $count = [int](Get-ComProperty $sheets 'Count')
    for ($i = 1; $i -le $count; $i++) {
        $sheet = Get-ComItem $sheets $i
        if ([int](Get-ComProperty $sheet 'Visible') -ne -1) { continue }  # xlSheetVisible
        if ([int](Get-ComProperty (Get-ComProperty $sheet 'Shapes') 'Count') -gt 0) { return $false }
        $filled = Invoke-ComMethod $functions 'CountA' ([ordered]@{ Arg1 = (Get-ComProperty $sheet 'UsedRange') })
        if ([double]$filled -gt 0) { return $false }
    }
    return $true
}

function Get-HResult($ErrorRecord) {
    $e = $ErrorRecord.Exception
    while ($e) {
        if ($e -is [System.Runtime.InteropServices.COMException]) { return ('0x{0:X8}' -f $e.ErrorCode) }
        $e = $e.InnerException
    }
    return $null
}

function Get-Detail($ErrorRecord) {
    $e = $ErrorRecord.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    return $e.Message
}

$apps = @{
    word       = @{ ProgId = 'Word.Application'; Process = 'WINWORD' }
    excel      = @{ ProgId = 'Excel.Application'; Process = 'EXCEL' }
    powerpoint = @{ ProgId = 'PowerPoint.Application'; Process = 'POWERPNT' }
}
$info = $apps[$App]
if (-not $info -or -not $InputPath -or -not $OutputPath) {
    Send-Event @{ event = 'error'; stage = 'args'; detail = 'Faltan datos de entrada' }
    exit 2
}

# Procesos de Office que ya existían: no se tocan nunca.
$before = @(Get-Process -Name $info.Process -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })

$stage = 'start'
$office = $null
$document = $null
$started = @()
$previousSecurity = $null
try {
    $office = New-Object -ComObject $info.ProgId
    # Solo los procesos nuevos con «/Automation» son de EFC. Ojo: el Office que abre el usuario desde el
    # Explorador también lleva «-Embedding», así que eso no basta para distinguirlos.
    $started = @(Get-CimInstance Win32_Process -Filter "Name = '$($info.Process).EXE'" -ErrorAction SilentlyContinue |
        Where-Object { $before -notcontains $_.ProcessId -and $_.CommandLine -match '/Automation' } |
        ForEach-Object { [int]$_.ProcessId })
    Send-Event @{ event = 'started'; pids = $started }

    $stage = 'open'
    $previousSecurity = Get-ComProperty $office 'AutomationSecurity'
    Set-ComProperty $office 'AutomationSecurity' 3  # msoAutomationSecurityForceDisable
    switch ($App) {
        'word' {
            Set-ComProperty $office 'Visible' $false
            Set-ComProperty $office 'DisplayAlerts' 0  # wdAlertsNone
            $documents = Get-ComProperty $office 'Documents'
            $document = Invoke-ComMethod $documents 'Open' ([ordered]@{
                    FileName              = $InputPath
                    ConfirmConversions    = $false
                    ReadOnly              = $true
                    AddToRecentFiles      = $false
                    PasswordDocument      = $DummyPassword
                    PasswordTemplate      = $DummyPassword
                    WritePasswordDocument = $DummyPassword
                    Visible               = $false
                    OpenAndRepair         = $false
                    NoEncodingDialog      = $true
                })
            $stage = 'export'
            [void](Invoke-ComMethod $document 'ExportAsFixedFormat' ([ordered]@{
                        OutputFileName     = $OutputPath
                        ExportFormat       = 17     # wdExportFormatPDF
                        OpenAfterExport    = $false
                        OptimizeFor        = 0      # wdExportOptimizeForPrint
                        Range              = 0      # wdExportAllDocument
                        Item               = 0      # wdExportDocumentContent
                        IncludeDocProps    = $true
                        KeepIRM            = $true
                        CreateBookmarks    = 1      # wdExportCreateHeadingBookmarks
                        DocStructureTags   = $true
                        BitmapMissingFonts = $true
                        UseISO19005_1      = $false
                    }))
        }
        'excel' {
            Set-ComProperty $office 'Visible' $false
            Set-ComProperty $office 'DisplayAlerts' $false
            Set-ComProperty $office 'EnableEvents' $false
            $workbooks = Get-ComProperty $office 'Workbooks'
            $document = Invoke-ComMethod $workbooks 'Open' ([ordered]@{
                    Filename                  = $InputPath
                    UpdateLinks               = 0
                    ReadOnly                  = $true
                    Password                  = $DummyPassword
                    IgnoreReadOnlyRecommended = $true
                    Notify                    = $false
                    AddToMru                  = $false
                })
            $stage = 'export'
            # Todo el libro: las hojas visibles, una detrás de otra (las ocultas no se imprimen).
            [void](Invoke-ComMethod $document 'ExportAsFixedFormat' ([ordered]@{
                        Type                 = 0  # xlTypePDF
                        Filename             = $OutputPath
                        Quality              = 0  # xlQualityStandard
                        IncludeDocProperties = $true
                        IgnorePrintAreas     = $false
                        OpenAfterPublish     = $false
                    }))
        }
        'powerpoint' {
            # PowerPoint no admite ocultar la aplicación: se abre la presentación sin ventana.
            $presentations = Get-ComProperty $office 'Presentations'
            $document = Invoke-ComMethod $presentations 'Open' ([ordered]@{
                    FileName   = "$($InputPath)::$($DummyPassword)::"
                    ReadOnly   = -1  # msoTrue
                    Untitled   = 0
                    WithWindow = 0
                })
            $stage = 'export'
            [void](Invoke-ComMethod $document 'SaveCopyAs' ([ordered]@{
                        FileName   = $OutputPath
                        FileFormat = 32  # ppSaveAsPDF
                    }))
        }
    }
    Send-Event @{ event = 'done' }
    $code = 0
}
catch {
    $failure = @{ event = 'error'; stage = $stage; hresult = (Get-HResult $_); detail = (Get-Detail $_) }
    if ($App -eq 'excel' -and $stage -eq 'export' -and $document) {
        try { if (Test-ExcelEmpty $office $document) { $failure.stage = 'empty' } } catch { }
    }
    Send-Event $failure
    $code = 1
}
finally {
    if ($document) {
        try {
            switch ($App) {
                'word' { [void](Invoke-ComMethod $document 'Close' ([ordered]@{ SaveChanges = 0 })) }
                'excel' { [void](Invoke-ComMethod $document 'Close' ([ordered]@{ SaveChanges = $false })) }
                'powerpoint' { [void](Invoke-ComMethod $document 'Close') }
            }
        }
        catch { }
    }
    $quit = $false
    if ($office) {
        try {
            if ($null -ne $previousSecurity) { Set-ComProperty $office 'AutomationSecurity' $previousSecurity }
        }
        catch { Send-Event @{ event = 'warning'; stage = 'security'; detail = (Get-Detail $_) } }
        try {
            # Si el usuario ha abierto algo en esta misma instancia mientras tanto, se le deja a la vista.
            $collection = @{ word = 'Documents'; excel = 'Workbooks'; powerpoint = 'Presentations' }[$App]
            $open = [int](Get-ComProperty (Get-ComProperty $office $collection) 'Count')
            if ($open -eq 0 -and ($App -ne 'powerpoint' -or $started.Count -gt 0)) {
                [void](Invoke-ComMethod $office 'Quit')
                $quit = $true
            }
            elseif ($open -gt 0 -and $App -ne 'powerpoint') {
                Set-ComProperty $office 'Visible' $true
            }
        }
        catch { Send-Event @{ event = 'warning'; stage = 'quit'; detail = (Get-Detail $_) } }
    }
    # Office no termina mientras queden referencias COM vivas (también las que retiene un error).
    foreach ($o in @($document, $documents, $workbooks, $presentations, $office)) {
        if ($o) { try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($o) } catch { } }
    }
    $document = $documents = $workbooks = $presentations = $office = $null
    $Error.Clear()
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    [GC]::Collect()
    # Último recurso: el proceso que abrió EFC y al que ya se pidió salir, si no lo ha hecho en 5 s.
    if ($quit) {
        foreach ($id in $started) {
            try { Wait-Process -Id $id -Timeout 5 -ErrorAction Stop }
            catch {
                if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
                    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
                    Send-Event @{ event = 'warning'; stage = 'quit'; detail = "Office no se cerró solo; se terminó el proceso $id" }
                }
            }
        }
    }
}
exit $code
