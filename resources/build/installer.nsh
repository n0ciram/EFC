; EFC — pasos adicionales del instalador NSIS (electron-builder incluye este archivo automáticamente).

; Diálogo de idioma al empezar (displayLanguageSelector): título y texto bilingües, solo en ASCII
; porque NSIS lee este archivo sin BOM con la página de códigos del sistema.
!macro customHeader
  !define MUI_LANGDLL_WINDOWTITLE "EFC - Easy File Converter"
  !define MUI_LANGDLL_INFO "Elige el idioma / Choose your language"
!macroend

; El idioma elegido ($LANGUAGE: 3082 español, 1033 inglés) queda junto a EFC.exe; EFC lo aplica al
; arrancar, una vez por instalación (después manda lo que se elija en Ajustes).
!macro customInstall
  FileOpen $0 "$INSTDIR\installer-language.txt" w
  FileWrite $0 "$LANGUAGE"
  FileClose $0
!macroend

!macro customUnInstall
  ; Al actualizar, el instalador nuevo ejecuta este desinstalador: no se quita nada que EFC vaya a
  ; seguir usando. Solo en una desinstalación real se retiran el inicio con Windows y el menú contextual.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "es.efc.easyfileconverter"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "es.efc.easyfileconverter"
    ; «Convertir con EFC» en el menú del botón derecho (lista sincronizada con electron/windows/context-menu.ts).
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.3g2\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.3gp\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.aac\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.aif\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.aifc\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.aiff\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.amr\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.asf\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.avi\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.avif\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.bmp\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.csv\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.dib\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.doc\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.docx\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.flac\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.flv\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.gif\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.jfif\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.jpe\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.jpeg\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.jpg\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.log\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.m2ts\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.m4a\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.m4v\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.md\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.mkv\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.mov\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.mp3\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.mp4\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.mpeg\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.mpg\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.mts\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.odp\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.ods\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.odt\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.oga\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.ogg\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.opus\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.png\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.pps\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.ppsx\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.ppt\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.pptx\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.qt\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.rtf\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.svg\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.text\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.tif\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.tiff\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.ts\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.txt\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.vob\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.wav\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.webm\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.webp\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.wma\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.wmv\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.xls\shell\EFC.Convert"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.xlsx\shell\EFC.Convert"
  ${endIf}
!macroend
