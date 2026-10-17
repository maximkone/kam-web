<!-- Facts extracted from the Pascal source (_ref/kam_remake/src) by tools/flashpool (DeepSeek V4 Flash free), one single-shot job per file, 2026-10-17. Every row carries a src line and a verbatim quote; tools/flashpool/audit-facts.mjs checks that each quote appears at the cited line (+-3): 182 of 190 checkable rows verified (96%). Rows that cite several ranges or have no quote (mostly resunits.md) are unverified: re-read the Pascal before relying on them. -->

# resunits

| unit | hit points | attack | defence (if present) | speed | sight | other combat fields | src | quote |
|---|---|---|---|---|---|---|---|---|
| utNone | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utAny | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utSerf | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utWoodcutter | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utMiner | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utAnimalBreeder | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utFarmer | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utCarpenter | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utBaker | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utButcher | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utFisher | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utBuilder | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utStonemason | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utSmith | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utMetallurgist | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utRecruit | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utMilitia | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | ArmyPower=1; FightType=ftMelee | KM_ResUnits.pas:339,365 | `1, 2.4, 5.2,    // utMilitia` |
| utAxeFighter | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | ArmyPower=2.4; FightType=ftMelee; Shield bonus +0.5 bolt/+1 bow | KM_ResUnits.pas:258-272,339,365 | `2.4, 5.2,    // utMilitia, utAxeFighter`<br>`utAxeFighter, utSwordFighter, utScout, utKnight` |
| utSwordFighter | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | ArmyPower=5.2; FightType=ftMelee; Shield bonus +0.5 bolt/+1 bow | KM_ResUnits.pas:258-272,339,365 | `5.2,    // utMilitia, utAxeFighter, utSwordFighter`<br>`utAxeFighter, utSwordFighter, utScout, utKnight` |
| utBowman | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | ArmyPower=2.4; FightType=ftRanged | KM_ResUnits.pas:340,366 | `2.4, 4,         // utBowman` |
| utCrossbowman | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | ArmyPower=4; FightType=ftRanged | KM_ResUnits.pas:340,366 | `4,         // utBowman, utCrossbowman` |
| utLanceCarrier | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | ArmyPower=2; FightType=ftMelee; AttackHorse 60 (was 55) | KM_ResUnits.pas:341,367,571,587-588 | `2, 4,           // utLanceCarrier`<br>`fItems[utLanceCarrier].fUnitDat.AttackHorse := 60;` |
| utPikeman | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | ArmyPower=4; FightType=ftMelee | KM_ResUnits.pas:341,367 | `4,           // utLanceCarrier, utPikeman` |
| utScout | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | 40 (was 39) | 13 (was 9) | ArmyPower=3.3; FightType=ftMelee; Shield bonus +0.5 bolt/+1 bow | KM_ResUnits.pas:258-272,342,368,568-569,579,591-592 | `DEF_SCOUT_SIGHT = 9;`<br>`fItems[utScout].fUnitDat.Sight := 13;`<br>`fItems[utScout].fUnitDat.Speed := 40;` |
| utKnight | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | 40 (was 39) | NOT-IN-FILE | ArmyPower=6.3; FightType=ftMelee; Shield bonus +0.5 bolt/+1 bow | KM_ResUnits.pas:258-272,342,368,572,594-595 | `fItems[utKnight].fUnitDat.Speed := 40;`<br>`6.3,       // utScout, utKnight`<br>`utAxeFighter, utSwordFighter, utScout, utKnight` |
| utBarbarian | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | ArmyPower=5.3; FightType=ftMelee | KM_ResUnits.pas:343,369 | `5.3, 0.8, 1.2,  // utBarbarian, utRebel, utRogue` |
| utRebel | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | ArmyPower=0.8; FightType=ftMelee; AttackHorse 50 (was 60) | KM_ResUnits.pas:343,370,570,584-585 | `5.3, 0.8, 1.2,  // utBarbarian, utRebel, utRogue`<br>`fItems[utRebel].fUnitDat.AttackHorse := 50;` |
| utRogue | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | ArmyPower=1.2; FightType=ftRanged | KM_ResUnits.pas:343,371 | `5.3, 0.8, 1.2,  // utBarbarian, utRebel, utRogue` |
| utWarrior | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | ArmyPower=5.3; FightType=ftMelee | KM_ResUnits.pas:344,372 | `5.3, 1.9        // utWarrior` |
| utVagabond | NOT-IN-FILE | 35 (was 40) | NOT-IN-FILE | 40 (was 39) | NOT-IN-FILE | ArmyPower=1.9; FightType=ftMelee | KM_ResUnits.pas:344,373,569,581-582,597-598 | `fItems[utVagabond].fUnitDat.Attack := 35;`<br>`fItems[utVagabond].fUnitDat.Speed := 40;`<br>`1.9        // utWarrior, utVagabond` |
| utWolf | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utFish | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utWatersnake | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utSeastar | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utCrab | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utWaterflower | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utWaterleaf | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |
| utDuck | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |