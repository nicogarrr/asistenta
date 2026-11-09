// AsistentaHid: el PC con Windows como teclado + raton + puntero ABSOLUTO del iPhone por
// Bluetooth LE (HID sobre GATT, HOGP), sin la ESP32 y sin instalar nada: se compila con el
// csc.exe que ya trae Windows (compilar-hid.ps1) contra las APIs WinRT de la caja.
//
// Idea de abhishek-raj/windows-ble-hid (BleHid, MIT): publicar el servicio HID 0x1812 con
// GattServiceProvider. Codigo propio, no copiado. El mapa de informes y lo que se manda lo
// decide Asistenta (src/iphone/hid-informes.ts); esto solo publica y reproduce.
//
// Protocolo: una linea JSON por mensaje en stdin/stdout.
//   {"id":1,"op":"estado"}                     -> {"id":1,"ok":true,"periferico":..,"anunciando":..,"conectado":..}
//   {"id":2,"op":"enviar","pasos":[{"r":3,"d":"<base64>","ms":8},..]} -> {"id":2,"ok":true,"enviados":n}
//   {"op":"salir"}
// El mapa de informes llega en la linea de arranque: AsistentaHid.exe lee la primera
// linea {"op":"mapa","d":"<base64>"} antes de publicar nada.
//
// C# 5 (el compilador de .NET Framework 4.x): sin interpolacion ni ?.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

public static class AsistentaHid
{
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint p);

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly object Salida = new object();
    static readonly Dictionary<int, GattLocalCharacteristic> Informes = new Dictionary<int, GattLocalCharacteristic>();
    static readonly Dictionary<int, byte[]> Ultimo = new Dictionary<int, byte[]>();
    static GattServiceProvider Proveedor;
    static bool Periferico;
    static string Problema = "";

    static Guid Uuid(int corto)
    {
        return new Guid(corto.ToString("x4").PadLeft(8, '0') + "-0000-1000-8000-00805f9b34fb");
    }

    static void Escribir(Dictionary<string, object> m)
    {
        lock (Salida) { Console.Out.WriteLine(Json.Serialize(m)); Console.Out.Flush(); }
    }

    static void Evento(string nombre, string mensaje)
    {
        var m = new Dictionary<string, object>();
        m["evento"] = nombre;
        m["mensaje"] = mensaje;
        Escribir(m);
    }

    public static int Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = new UTF8Encoding(false);
        try { timeBeginPeriod(1); } catch { } // reloj de 1 ms para los 8 ms entre informes
        try { return Ejecutar().GetAwaiter().GetResult(); }
        catch (Exception e) { Evento("error", e.Message); return 1; }
        finally { if (Proveedor != null) { try { Proveedor.StopAdvertising(); } catch { } } }
    }

    static async Task<int> Ejecutar()
    {
        var primera = Console.In.ReadLine();
        if (primera == null) return 2;
        var arranque = Json.Deserialize<Dictionary<string, object>>(primera);
        byte[] mapa = Convert.FromBase64String((string)arranque["d"]);

        var adaptador = await BluetoothAdapter.GetDefaultAsync();
        if (adaptador == null) { Problema = "este PC no tiene Bluetooth (o esta apagado)"; }
        else if (!adaptador.IsLowEnergySupported) { Problema = "el Bluetooth de este PC no tiene LE"; }
        else if (!adaptador.IsPeripheralRoleSupported) { Problema = "el Bluetooth de este PC no puede hacer de periferico LE (rol peripheral): con este adaptador no se puede"; }
        else { Periferico = true; }
        if (Periferico) { await Publicar(mapa); }
        Evento(Periferico ? "listo" : "sin_periferico", Problema);

        string linea;
        while ((linea = Console.In.ReadLine()) != null)
        {
            Dictionary<string, object> msg;
            try { msg = Json.Deserialize<Dictionary<string, object>>(linea); }
            catch { continue; }
            object op; msg.TryGetValue("op", out op);
            if ("salir".Equals(op)) break;
            var r = new Dictionary<string, object>();
            object id; if (msg.TryGetValue("id", out id)) r["id"] = id;
            try
            {
                if ("estado".Equals(op)) Estado(r);
                else if ("enviar".Equals(op)) await Enviar((ArrayList)msg["pasos"], r);
                else { r["ok"] = false; r["error"] = "op desconocida"; }
            }
            catch (Exception e) { r["ok"] = false; r["error"] = e.Message; }
            Escribir(r);
        }
        return 0;
    }

    static void Estado(Dictionary<string, object> r)
    {
        bool anunciando = Proveedor != null && Proveedor.AdvertisementStatus == GattServiceProviderAdvertisementStatus.Started;
        GattLocalCharacteristic abs;
        bool conectado = Informes.TryGetValue(3, out abs) && abs.SubscribedClients.Count > 0;
        r["ok"] = true;
        r["periferico"] = Periferico;
        r["anunciando"] = anunciando;
        r["conectado"] = conectado;
        if (Problema.Length > 0) r["problema"] = Problema;
    }

    static void Esperar(Stopwatch reloj, double hastaMs)
    {
        while (true)
        {
            double falta = hastaMs - reloj.Elapsed.TotalMilliseconds;
            if (falta <= 0) return;
            if (falta > 2) Thread.Sleep((int)(falta - 1)); else Thread.SpinWait(200);
        }
    }

    static async Task Enviar(ArrayList pasos, Dictionary<string, object> r)
    {
        if (!Periferico) throw new Exception(Problema);
        int enviados = 0;
        var reloj = Stopwatch.StartNew();
        double hasta = 0;
        try
        {
            foreach (var o in pasos)
            {
                var p = (Dictionary<string, object>)o;
                int id = Convert.ToInt32(p["r"]);
                byte[] datos = Convert.FromBase64String((string)p["d"]);
                GattLocalCharacteristic c;
                if (!Informes.TryGetValue(id, out c)) throw new Exception("informe " + id + " no publicado");
                if (c.SubscribedClients.Count == 0) throw new Exception("el iPhone no esta suscrito (no conectado)");
                Ultimo[id] = datos;
                await c.NotifyValueAsync(datos.AsBuffer());
                enviados++;
                hasta += Convert.ToDouble(p["ms"]);
                Esperar(reloj, hasta);
            }
            r["ok"] = true;
        }
        finally { r["enviados"] = enviados; }
    }

    static GattLocalCharacteristicParameters Param(GattCharacteristicProperties props, byte[] fijo)
    {
        var p = new GattLocalCharacteristicParameters();
        p.CharacteristicProperties = props;
        p.ReadProtectionLevel = GattProtectionLevel.EncryptionRequired;
        p.WriteProtectionLevel = GattProtectionLevel.EncryptionRequired;
        if (fijo != null) p.StaticValue = fijo.AsBuffer();
        return p;
    }

    static async Task<GattLocalCharacteristic> Caracteristica(GattLocalService s, int uuid, GattLocalCharacteristicParameters p, string nombre)
    {
        var res = await s.CreateCharacteristicAsync(Uuid(uuid), p);
        if (res.Error != BluetoothError.Success) throw new Exception(nombre + ": " + res.Error);
        return res.Characteristic;
    }

    static void AceptarEscrituras(GattLocalCharacteristic c)
    {
        c.WriteRequested += async (s, a) =>
        {
            var aplazo = a.GetDeferral();
            try
            {
                var w = await a.GetRequestAsync();
                if (w != null && w.Option == GattWriteOption.WriteWithResponse) w.Respond();
            }
            finally { aplazo.Complete(); }
        };
    }

    static void LeerUltimo(GattLocalCharacteristic c, int id, int largo)
    {
        c.ReadRequested += async (s, a) =>
        {
            var aplazo = a.GetDeferral();
            try
            {
                var q = await a.GetRequestAsync();
                byte[] v;
                if (!Ultimo.TryGetValue(id, out v)) v = new byte[largo];
                if (q != null) q.RespondWithValue(v.AsBuffer());
            }
            finally { aplazo.Complete(); }
        };
    }

    static async Task Publicar(byte[] mapa)
    {
        var res = await GattServiceProvider.CreateAsync(Uuid(0x1812));
        if (res.Error != BluetoothError.Success) throw new Exception("servicio HID 0x1812: " + res.Error);
        Proveedor = res.ServiceProvider;
        var s = Proveedor.Service;
        var R = GattCharacteristicProperties.Read;
        // HID Information: bcdHID 1.11, sin pais, "normalmente conectable".
        await Caracteristica(s, 0x2A4A, Param(R, new byte[] { 0x11, 0x01, 0x00, 0x02 }), "HID Information");
        await Caracteristica(s, 0x2A4B, Param(R, mapa), "Report Map");
        var control = await Caracteristica(s, 0x2A4C, Param(GattCharacteristicProperties.WriteWithoutResponse, null), "HID Control Point");
        AceptarEscrituras(control);
        var modo = await Caracteristica(s, 0x2A4E, Param(R | GattCharacteristicProperties.WriteWithoutResponse, null), "Protocol Mode");
        AceptarEscrituras(modo);
        Ultimo[0] = new byte[] { 0x01 }; // modo informe
        LeerUltimo(modo, 0, 1);
        int[][] informes = new int[][] { new int[] { 1, 8 }, new int[] { 2, 4 }, new int[] { 3, 5 } };
        foreach (var inf in informes)
        {
            var c = await Caracteristica(s, 0x2A4D, Param(R | GattCharacteristicProperties.Notify, null), "Report " + inf[0]);
            LeerUltimo(c, inf[0], inf[1]);
            var dp = new GattLocalDescriptorParameters();
            dp.ReadProtectionLevel = GattProtectionLevel.EncryptionRequired;
            dp.StaticValue = new byte[] { (byte)inf[0], 0x01 }.AsBuffer(); // Report Reference: id, entrada
            var d = await c.CreateDescriptorAsync(Uuid(0x2908), dp);
            if (d.Error != BluetoothError.Success) throw new Exception("Report Reference " + inf[0] + ": " + d.Error);
            int idInforme = inf[0];
            c.SubscribedClientsChanged += (x, y) => Evento("suscritos", "informe " + idInforme + ": " + x.SubscribedClients.Count);
            Informes[inf[0]] = c;
        }
        // Bateria (HOGP la pide): 100 %.
        var bat = await GattServiceProvider.CreateAsync(Uuid(0x180F));
        if (bat.Error == BluetoothError.Success)
        {
            var bp = new GattLocalCharacteristicParameters();
            bp.CharacteristicProperties = R;
            bp.ReadProtectionLevel = GattProtectionLevel.Plain;
            bp.StaticValue = new byte[] { 100 }.AsBuffer();
            await bat.ServiceProvider.Service.CreateCharacteristicAsync(Uuid(0x2A19), bp);
            var bpar = new GattServiceProviderAdvertisingParameters();
            bpar.IsConnectable = true;
            bpar.IsDiscoverable = false;
            bat.ServiceProvider.StartAdvertising(bpar);
        }
        Proveedor.AdvertisementStatusChanged += (x, y) => Evento("anuncio", y.Status.ToString());
        var par = new GattServiceProviderAdvertisingParameters();
        par.IsConnectable = true;
        par.IsDiscoverable = true;
        Proveedor.StartAdvertising(par);
    }
}
