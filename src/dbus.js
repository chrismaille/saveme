export const DAEMON_INTERFACE = `
<node>
  <interface name="io.github.chrismaille.SaveMe.Daemon">
    <method name="GetSnapshot">
      <arg type="s" direction="out"/>
    </method>
    <method name="RunJob">
      <arg type="s" direction="in"/>
      <arg type="b" direction="in"/>
      <arg type="b" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="PlayJob">
      <arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="CancelJob">
      <arg type="s" direction="in"/>
    </method>
    <method name="PauseJob">
      <arg type="s" direction="in"/>
      <arg type="b" direction="in"/>
    </method>
    <method name="SetJobEnabled">
      <arg type="s" direction="in"/>
      <arg type="b" direction="in"/>
    </method>
    <method name="PauseAll">
      <arg type="b" direction="in"/>
    </method>
    <method name="SaveJob">
      <arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="ImportJob">
      <arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="InspectBackup">
      <arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="DeleteJob">
      <arg type="s" direction="in"/>
    </method>
    <method name="GetRun">
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="GetRunLog">
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="ListRuns">
      <arg type="s" direction="in"/>
      <arg type="u" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="ListVersions">
      <arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="ListRemote">
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="b" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="ListBackup">
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="b" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="Restore">
      <arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="BeginRemoteAuth">
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="GetRemoteAuth">
      <arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="CancelRemoteAuth">
      <arg type="s" direction="in"/>
    </method>
    <method name="DeleteRemote">
      <arg type="s" direction="in"/>
    </method>
    <method name="Doctor">
      <arg type="s" direction="out"/>
    </method>
    <method name="GetLogsInfo">
      <arg type="s" direction="out"/>
    </method>
    <method name="PruneLogs">
      <arg type="s" direction="out"/>
    </method>
    <method name="ClearLogs">
      <arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="SanitizeLogs">
      <arg type="s" direction="out"/>
    </method>
    <method name="UpdateSettings">
      <arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="Quit"/>
    <signal name="SnapshotChanged">
      <arg type="s"/>
    </signal>
    <signal name="RunFinished">
      <arg type="s"/>
      <arg type="s"/>
      <arg type="s"/>
    </signal>
    <signal name="RemoteAuthChanged">
      <arg type="s"/>
      <arg type="s"/>
    </signal>
  </interface>
</node>
`;
