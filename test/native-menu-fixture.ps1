# 仅供测试使用。这是无害的托管 WinForms 窗口，不是 DSH。不使用原生助手、
# P/Invoke 或外部工具，也不修改安全配置。
# 此处有意使用 Windows PowerShell 5.1：.NET Framework 的 ContextMenu 提供
# 标准 #32768 菜单；.NET 10 中已没有这一旧类型。
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
