<!-- Facts extracted from the Pascal source (_ref/kam_remake/src) by tools/flashpool (DeepSeek V4 Flash free), one single-shot job per file, 2026-10-17. Every row carries a src line and a verbatim quote; tools/flashpool/audit-facts.mjs checks that each quote appears at the cited line (+-3): 182 of 190 checkable rows verified (96%). Rows that cite several ranges or have no quote (mostly resunits.md) are unverified: re-read the Pascal before relying on them. -->

# school

| rule | value | src | quote |
|---|---|---|---|
| Training queue size | 1 wip + 5 in line | KM_HouseSchool.pas:11 | `1 wip + 5 in line` |
| What a unit costs | 1 gold | KM_HouseSchool.pas:157 | `//We Lock 1 gold if its hidden (while unit training)` |
| Gold needed to start training | at least 1 gold must be in school input | KM_HouseSchool.pas:255 | `if CheckWareIn(wtGold) = 0 then Exit;` |
| Training time | 150 steps | KM_HouseSchool.pas:16 | `fTrainProgress: Byte; //Was it 150 steps in KaM?` |
| Who can be trained | NOT-IN-FILE | KM_HouseSchool.pas:32 | `aUnit: TKMUnitType; aCount: Integer` |
| How a finished unit spawns | NOT-IN-FILE | KM_HouseSchool.pas:266 | `//Unit reports back to School that it was trained` |