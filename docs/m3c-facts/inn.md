<!-- Facts extracted from the Pascal source (_ref/kam_remake/src) by tools/flashpool (DeepSeek V4 Flash free), one single-shot job per file, 2026-10-17. Every row carries a src line and a verbatim quote; tools/flashpool/audit-facts.mjs checks that each quote appears at the cited line (+-3): 182 of 190 checkable rows verified (96%). Rows that cite several ranges or have no quote (mostly resunits.md) are unverified: re-read the Pascal before relying on them. -->

# inn

| rule | value | src | quote |
|---|---|---|---|
| Maximum simultaneous eaters (eating places) | 6 | KM_HouseInn.pas:11 | INN_MAX_EATERS = 6; |
| Eater slots array size | 0..INN_MAX_EATERS-1 (6 slots) | KM_HouseInn.pas:16 | fEater: array [0..INN_MAX_EATERS - 1] of record |
| EatStep uses global FlagAnimStep instead of per-eater anim counters | FlagAnimStep | KM_HouseInn.pas:62 | //EatStep := FlagAnimStep, cos increases it each frame |
| EaterGetsRandomEmptySlot returns -1 when no slot found | -1 | KM_HouseInn.pas:68 | Result := -1; |
| Non-empty slots are excluded from empty list | UnitType <> utNone | KM_HouseInn.pas:75 | if fEater[I].UnitType <> utNone then |
| Random empty slot search start | KaMRandom(INN_MAX_EATERS) | KM_HouseInn.pas:78 | offset := KaMRandom(INN_MAX_EATERS |
| Slots are scanned modulo INN_MAX_EATERS | (offset + I) mod INN_MAX_EATERS | KM_HouseInn.pas:82 | idx := (offset + I) mod INN_MAX_EATERS; |
| Entering eater stores unit type | aUnitType | KM_HouseInn.pas:85 | fEater[idx].UnitType := aUnitType; |
| Entering eater has no food yet | wtNone | KM_HouseInn.pas:86 | fEater[idx].FoodKind := wtNone; |
| Entering eater starts EatStep at global flag animation step | FlagAnimStep | KM_HouseInn.pas:87 | fEater[idx].EatStep  := FlagAnimStep; |
| UpdateEater ignores invalid eater index | aIndex = -1 | KM_HouseInn.pas:96 | if aIndex = -1 then Exit; |
| Allowed food types in inn | wtWine, wtBread, wtSausage, wtFish | KM_HouseInn.pas:98 | Assert(aFoodKind in [wtWine, wtBread, wtSausage, wtFish] |
| On receiving food, FoodKind is set to delivered ware | aFoodKind | KM_HouseInn.pas:100 | fEater[aIndex].FoodKind := aFoodKind; |
| Food-kind order used by eaters | Wine-Bread-Sausages-Fish | KM_HouseInn.pas:100 | //Order is Wine-Bread-Sausages-Fish |
| On receiving food, EatStep is reset | FlagAnimStep | KM_HouseInn.pas:101 | fEater[aIndex].EatStep  := FlagAnimStep; |
| Leaving eater clears slot | utNone | KM_HouseInn.pas:108 | fEater[aIndex].UnitType := utNone; |
| Inn has food if any of the four food wares is present | CheckWareIn(wtSausage)+CheckWareIn(wtBread)+CheckWareIn(wtWine)+CheckWareIn(wtFish) > 0 | KM_HouseInn.pas:114 | Result := CheckWareIn(wtSausage) + CheckWareIn(wtBread) |
| Food quantity in inn | CheckWareIn(wtSausage)+CheckWareIn(wtBread)+CheckWareIn(wtWine)+CheckWareIn(wtFish) | KM_HouseInn.pas:120 | CheckWareIn(wtWine) + CheckWareIn(wtFish); |
| HasSpace true if at least one slot has no unit | any fEater[I].UnitType = utNone | KM_HouseInn.pas:130 | Result := Result or (fEater[I].UnitType = utNone); |
| Eater animation facing convention | directions 135 face south, 246 face north | KM_HouseInn.pas:143 | eater animation direction (135 face south, 246 face north) |
| Wine eater facing direction formula | TKMDirection(1*2-1 + (aIndex div 3)) | KM_HouseInn.pas:147 | TKMDirection(1 * 2 - 1 + (aIndex div 3)); |
| Bread eater facing direction formula | TKMDirection(2*2-1 + (aIndex div 3)) | KM_HouseInn.pas:148 | TKMDirection(2 * 2 - 1 + (aIndex div 3)); |
| Sausage eater facing direction formula | TKMDirection(3*2-1 + (aIndex div 3)) | KM_HouseInn.pas:149 | TKMDirection(3 * 2 - 1 + (aIndex div 3)); |
| Fish eater facing direction formula | TKMDirection(4*2-1 + (aIndex div 3)) | KM_HouseInn.pas:150 | TKMDirection(4 * 2 - 1 + (aIndex div 3)); |
| No food results in undefined direction | dirNA | KM_HouseInn.pas:152 | Result  := dirNA; |
| Eating place horizontal offsets | -0.5, 0, 0.5 | KM_HouseInn.pas:156 | offX: array [0..2] of Single = ( -0.5, 0, 0.5); |
| Eating place vertical offsets | -0.05, 0, 0.05 | KM_HouseInn.pas:157 | offY: array [0..2] of Single = (-0.05, 0, 0.05); |
| Eaters are drawn only in completed house | fBuildState = hbsDone | KM_HouseInn.pas:163 | if fBuildState <> hbsDone then exit; |
| Eater is drawn only after it has been assigned food | UnitType <> utNone and FoodKind <> wtNone | KM_HouseInn.pas:167 | if (fEater[I].UnitType = utNone) or (fEater[I].FoodKind |
| Eat animation step is difference between global flag step and EatStep | FlagAnimStep - fEater[I].EatStep | KM_HouseInn.pas:169 | animStep := FlagAnimStep - fEater[I].EatStep; |
| Eaters are rendered with eating animation | uaEat | KM_HouseInn.pas:171 | AddHouseEater(fPosition, fEater[I].UnitType, uaEat, |
| Eater position uses column index I mod 3 | offX[I mod 3], offY[I mod 3] | KM_HouseInn.pas:173 | offX[I mod 3], offY[I mod 3], |
| Eater is tinted with owner's game flag color | gHands[Owner].GameFlagColor | KM_HouseInn.pas:174 | gHands[Owner].GameFlagColor); |
| Maximum stored food (ware limit) | NOT-IN-FILE | NOT-IN-FILE | NOT-IN-FILE |