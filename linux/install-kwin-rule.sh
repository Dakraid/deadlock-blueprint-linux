#!/bin/sh
# Adds the overlay's window rule (deadlock-blueprint.kwinrule) to KWin, or updates it, and reloads KWin's rules.
# Same as System Settings › Window Management › Window Rules › Import. Remove it from there.
set -eu
group=deadlock-blueprint-overlay
rule="$(dirname "$0")/deadlock-blueprint.kwinrule"
grep '=' "$rule" | while IFS='=' read -r key value; do
  kwriteconfig6 --file kwinrulesrc --group "$group" --key "$key" "$value"
done
rules=$(kreadconfig6 --file kwinrulesrc --group General --key rules)
case ",$rules," in
  *",$group,"*) ;;
  *) rules="${rules:+$rules,}$group" ;;
esac
kwriteconfig6 --file kwinrulesrc --group General --key rules "$rules"
kwriteconfig6 --file kwinrulesrc --group General --key count "$(printf '%s\n' "$rules" | tr ',' '\n' | grep -c .)"
dbus-send --session --type=method_call --dest=org.kde.KWin /KWin org.kde.KWin.reconfigure
echo "KWin rule '$group' installed."
