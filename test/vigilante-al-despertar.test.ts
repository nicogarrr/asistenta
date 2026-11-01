import { describe, expect, it } from 'vitest';
import { RESUME_EVENT_QUERY, watchdogTaskXml } from '../src/autostart-watchdog.js';

const xml = watchdogTaskXml({ nodeExe: 'C:\\node\\node.exe', cliJs: 'C:\\a\\dist\\cli.js' });

describe('vigilante: revisa también al despertar el PC', () => {
  it('la tarea tiene un disparador por el evento de vuelta de suspensión', () => {
    const ev = xml.match(/<EventTrigger>([\s\S]*?)<\/EventTrigger>/);
    expect(ev).not.toBeNull();
    const body = ev?.[1] ?? '';
    expect(body).toContain('<Enabled>true</Enabled>');
    // un minuto de margen para que vuelva el Wi-Fi
    expect(body).toContain('<Delay>PT1M</Delay>');
    expect(body).toContain(
      "Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1",
    );
    // el esquema del Programador de tareas pide este orden: Enabled, Subscription, Delay
    expect(body.indexOf('<Enabled>')).toBeLessThan(body.indexOf('<Subscription>'));
    expect(body.indexOf('<Subscription>')).toBeLessThan(body.indexOf('<Delay>'));
  });

  it('la consulta va escapada dentro del XML (sin < ni > sueltos)', () => {
    const sub = xml.match(/<Subscription>([\s\S]*?)<\/Subscription>/)?.[1] ?? '';
    expect(sub.startsWith('&lt;QueryList&gt;')).toBe(true);
    expect(sub).not.toMatch(/[<>]/);
    expect(RESUME_EVENT_QUERY).toContain('Path="System"');
  });

  it('se mantienen el inicio de sesión y la revisión cada 5 min', () => {
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<Interval>PT5M</Interval>');
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
  });
});
