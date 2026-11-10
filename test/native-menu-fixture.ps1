# TEST ONLY. A harmless managed WinForms window, NOT DSH. No native helpers,
# P/Invoke, external tools or security configuration changes.
# Windows PowerShell 5.1 is intentional: .NET Framework ContextMenu exposes a
# standard #32768 menu; that legacy type is absent from .NET 10.
param([Parameter(Mandatory=$true)][string]$Receipt)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
public static class IsolatedMenuFixture {
    public static void Run(string receipt) {
        using (var form = new Form())
        using (var menu = new ContextMenu())
        using (var timer = new Timer()) {
            form.Text = "Isolated native menu test - not DSH";
            form.Size = new Size(300,100);
            form.ShowInTaskbar = false;
            var item = new MenuItem("Exit");
            item.Click += delegate { File.WriteAllText(receipt,"fixture-only"); form.Close(); };
            menu.MenuItems.Add(item);
            form.ContextMenu = menu;
            menu.Popup += delegate { File.AppendAllText(receipt+".events","popup;"); };
            menu.Collapse += delegate { File.AppendAllText(receipt+".events","collapse;"); };
            timer.Interval = 10000;
            timer.Tick += delegate { timer.Stop(); form.Close(); };
            form.Shown += delegate {
                timer.Start();
                form.Activate();
                menu.Show(form,new Point(10,10));
            };
            Application.Run(form);
        }
    }
}
'@
[IsolatedMenuFixture]::Run($Receipt)
