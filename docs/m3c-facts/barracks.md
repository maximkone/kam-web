<!-- Facts extracted from the Pascal source (_ref/kam_remake/src) by tools/flashpool (DeepSeek V4 Flash free), one single-shot job per file, 2026-10-17. Every row carries a src line and a verbatim quote; tools/flashpool/audit-facts.mjs checks that each quote appears at the cited line (+-3): 182 of 190 checkable rows verified (96%). Rows that cite several ranges or have no quote (mostly resunits.md) are unverified: re-read the Pascal before relying on them. -->

# barracks

| rule | value | src | quote |
|---|---|---|---|
| Recruit storage field | TList of recruits | KM_HouseBarracks.pas:15 | `fRecruitsList: TList;` |
| Warfare ware storage field | Array WARFARE_MIN..WARFARE_MAX of Word | KM_HouseBarracks.pas:16 | `fResourceCount: array [WARFARE_MIN..WARFARE_MAX] of Word;` |
| MapEd recruit counter | MapEdRecruitCount: Word | KM_HouseBarracks.pas:20 | `MapEdRecruitCount: Word; //Only used by MapEd` |
| Per-ware not-accept flag | NotAcceptFlag array | KM_HouseBarracks.pas:21 | `NotAcceptFlag: array [WARFARE_MIN .. WARFARE_MAX]` |
| Per-ware not-take-out flag | NotAllowTakeOutFlag array | KM_HouseBarracks.pas:22 | `NotAllowTakeOutFlag: array [WARFARE_MIN .. WARFARE_MAX]` |
| Recruit accept toggle flag | NotAcceptRecruitFlag: Boolean | KM_HouseBarracks.pas:23 | `NotAcceptRecruitFlag: Boolean;` |
| Recruit list creation | Created in constructor | KM_HouseBarracks.pas:77 | `fRecruitsList := TList.Create;` |
| Ware storage loaded from save | Reads fResourceCount block | KM_HouseBarracks.pas:89 | `LoadStream.Read(fResourceCount, SizeOf(fResourceCount));` |
| Recruit pointers resolved after load | Converts stored UIDs to unit pointers | KM_HouseBarracks.pas:110 | `gHands.GetUnitByUID(Integer(fRecruitsList.Items[I]))` |
| New barracks inherits accept/take-out settings | Copies from first barracks | KM_HouseBarracks.pas:133-137 | `NotAcceptFlag[WT] := firstBarracks.NotAcceptFlag[WT];` |
| Demolish forgets recruits | fRecruitsList.Clear | KM_HouseBarracks.pas:149 | `fRecruitsList.Clear;` |
| Demolish accounts stored wares as consumed | Stats.WareConsumed per ware | KM_HouseBarracks.pas:151-152 | `gHands[Owner].Stats.WareConsumed(W, fResourceCount[W]);` |
| Add recruit to barracks list | fRecruitsList.Add(aUnit) | KM_HouseBarracks.pas:160 | `fRecruitsList.Add(aUnit);` |
| Count recruits in barracks | fRecruitsList.Count | KM_HouseBarracks.pas:166 | `Result := fRecruitsList.Count;` |
| Remove recruit from barracks list | fRecruitsList.Remove(aUnit) | KM_HouseBarracks.pas:172 | `fRecruitsList.Remove(aUnit);` |
| Set ware count updates stored value | fResourceCount[aWareType] := aValue | KM_HouseBarracks.pas:184 | `fResourceCount[aWareType] := aValue;` |
| Ware add cap per type | Caps stored count at High(Word) | KM_HouseBarracks.pas:198 | `EnsureRange(fResourceCount[aWare] + aCount, 0, High(Word))` |
| Ware type accepted into barracks | Only WARFARE_MIN..WARFARE_MAX | KM_HouseBarracks.pas:203-206 | `Result := (aWare in [WARFARE_MIN..WARFARE_MAX]);` |
| Query ware count | Returns fResourceCount for warfare wares | KM_HouseBarracks.pas:209-215 | `Result := fResourceCount[aWare]` |
| Take wares out requires enough stored | aCount must not exceed stored | KM_HouseBarracks.pas:229 | `Assert(aCount <= fResourceCount[aWare]);` |
| Ware output available check | Stored >= requested count | KM_HouseBarracks.pas:237 | `Result := (fResourceCount[aWare] >= aCount);` |
| Total stored warfare wares | Sum over WARFARE_MIN..WARFARE_MAX | KM_HouseBarracks.pas:247 | `Inc(Result, fResourceCount[W]);` |
| Toggle per-ware not-accept | Flips NotAcceptFlag | KM_HouseBarracks.pas:255 | `NotAcceptFlag[aWare] := not NotAcceptFlag[aWare];` |
| Toggle not-accept for all wares | Sets every NotAcceptFlag to chosen value | KM_HouseBarracks.pas:270 | `NotAcceptFlag[ware] := accepted;` |
| Toggle per-ware not-take-out | Flips NotAllowTakeOutFlag | KM_HouseBarracks.pas:278 | `NotAllowTakeOutFlag[aWare] := not NotAllowTakeOutFlag[aWare]` |
| Toggle not-take-out for all wares | Sets every NotAllowTakeOutFlag to chosen value | KM_HouseBarracks.pas:293 | `NotAllowTakeOutFlag[ware] := accepted;` |
| Delivery to barracks abandon condition | Abandon if non-warfare or NotAcceptFlag | KM_HouseBarracks.pas:301 | `or NotAcceptFlag[aWareType];` |
| Delivery from barracks abandon condition | Abandon non-warfare wares | KM_HouseBarracks.pas:307 | `not (aWareType in [WARFARE_MIN .. WARFARE_MAX]);` |
| Delivery to nil house abandoned | aToHouse = nil | KM_HouseBarracks.pas:314 | `(aToHouse = nil)` |
| Allowed delivery destinations from barracks | Only Market, Store, or Barracks | KM_HouseBarracks.pas:316 | `not (aToHouse.HouseType in [htMarket, htStore, htBarracks])` |
| Market delivery mode | Market is allowed with any mode | KM_HouseBarracks.pas:317 | `allow delivery to Market with any mode` |
| Non-market delivery mode | Requires dmTakeOut | KM_HouseBarracks.pas:319 | `GetDeliveryModeForCheck(aImmediateCheck) <> dmTakeOut` |
| Non-market delivery blocked by flag | NotAllowTakeOutFlag blocks delivery | KM_HouseBarracks.pas:320 | `or NotAllowTakeOutFlag[aWareType]` |
| Toggle recruit acceptance | Flips NotAcceptRecruitFlag | KM_HouseBarracks.pas:327 | `NotAcceptRecruitFlag := not NotAcceptRecruitFlag;` |
| Can equip requires a recruit | At least one recruit needed | KM_HouseBarracks.pas:335 | `Result := RecruitsCount > 0;` |
| Can equip requires unit unlocked | Unit type must not be blocked | KM_HouseBarracks.pas:336 | `not gHands[Owner].Locks.GetUnitBlocked(aUnitType)` |
| Equip cost slots checked | Checks 4 TROOP_COST slots | KM_HouseBarracks.pas:338 | `for I := 1 to 4 do` |
| Exact per-soldier ware costs | NOT-IN-FILE; only TROOP_COST referenced | KM_HouseBarracks.pas:339 | `TROOP_COST[aUnitType, I] <> wtNone` |
| Equip requires each cost ware available | fResourceCount for each cost ware > 0 | KM_HouseBarracks.pas:340 | `fResourceCount[TROOP_COST[aUnitType, I]] > 0` |
| Equip consumes required wares | Decrements each required ware by 1 | KM_HouseBarracks.pas:360 | `SetWareCnt(costWareType, fResourceCount[costWareType] - 1);` |
| Equip kills the first recruit | KillInHouse on first recruit | KM_HouseBarracks.pas:367 | `TKMUnitRecruit(fRecruitsList.Items[0]).KillInHouse;` |
| Equip queue order | FIFO by recruit list | KM_HouseBarracks.pas:368 | `fRecruitsList.Delete(0);` |
| New warrior walks out of barracks | SetActionGoIn to go outside | KM_HouseBarracks.pas:375 | `newWarrior.SetActionGoIn(uaWalk, gdGoOutside, Self);` |
| Equippable unit type restriction | WARRIOR_EQUIPABLE_BARRACKS range only | KM_HouseBarracks.pas:391 | `Assert(aUnitType in [WARRIOR_EQUIPABLE_BARRACKS_MIN..` |
| Equip can queue multiple units | Loops aCount times | KM_HouseBarracks.pas:393 | `for I := 0 to aCount - 1 do` |
| Equip calls EquipWarrior per unit | EquipWarrior returns new warrior or nil | KM_HouseBarracks.pas:395 | `newWarrior := TKMUnitWarrior(EquipWarrior(aUnitType));` |
| Create recruit in MapEd mode | Increments MapEdRecruitCount | KM_HouseBarracks.pas:409 | `Inc(MapEdRecruitCount)` |
| Create recruit in normal mode | Trains utRecruit inside barracks | KM_HouseBarracks.pas:412 | `U := gHands[Owner].TrainUnit(utRecruit, Self);` |
| Recruit Home assignment | Home is used when walking out | KM_HouseBarracks.pas:414 | `U.Home := Self;` |
| Recruit creation stats | Stats.UnitCreated(utRecruit, False) | KM_HouseBarracks.pas:416 | `gHands[Owner].Stats.UnitCreated(utRecruit, False);` |
| Recruits saved as UIDs | fRecruitsList entries written as UID | KM_HouseBarracks.pas:430-431 | `SaveStream.Write(TKMUnit(fRecruitsList.Items[I]).UID);` |