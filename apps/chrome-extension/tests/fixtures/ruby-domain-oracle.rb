# frozen_string_literal: true

require 'date'
require 'json'

# Domain methods are loaded from the actual legacy sources. Browser-only gems are
# marked as loaded because this sanitized harness never opens Selenium or prompts.
$LOADED_FEATURES.concat(
  %w[selenium-webdriver.rb webdrivers/chromedriver.rb tty-prompt.rb pry.rb]
)
require File.expand_path('../../../standalone/source/Ahgora', __dir__)
require File.expand_path('../../../standalone/source/Expert', __dir__)

class SilentOracleLog
  def info(_message); end
  def debug(_message); end
end

request = JSON.parse($stdin.read)

result = case request.fetch('action')
when 'time_to_minutes'
  ahgora = Ahgora.new
  request.fetch('values').map { |value| ahgora.time_to_minutes(value) }
when 'negative_format'
  minutes = request.fetch('minutes')
  # Literal expression used by Ahgora#parse_mirror_calendar.
  format('%02d:%02d', minutes / 60, minutes % 60)
when 'override'
  ENV['AHGORA_PUNCH_OVERRIDES'] = request.fetch('raw')
  ahgora = Ahgora.new
  ahgora.set_log(SilentOracleLog.new)
  ahgora.punch_override_for(Date.iso8601(request.fetch('date')))
when 'expert'
  config = request.fetch('config')
  ENV['CHANNEL_DEFAULT_PROJECT'] = config.fetch('project')
  ENV['CHANNEL_DEFAULT_ACTIVITY'] = config.fetch('activity')
  ENV['CHANNEL_DEFAULT_ACTIVITY_TYPE'] = config.fetch('activity_type', '')
  ENV['CHANNEL_DEFAULT_TASK'] = config.fetch('task', '')
  expert = Expert.new
  expert.set_log(SilentOracleLog.new)
  begin
    { 'value' => expert.associaProjeto(request.fetch('date'), request.fetch('duration')) }
  rescue ArgumentError => e
    { 'error' => e.class.name, 'message' => e.message }
  end
when 'comparison'
  ahgora = request.fetch('ahgora').map { |row| [row.fetch('date'), row.fetch('duration')] }.to_h
  channel = request.fetch('channel').map { |row| [row.fetch('date'), row.fetch('duration')] }.to_h
  ahgora.keys.sort.map do |date|
    status = if !channel.key?(date)
      'missing'
    elsif channel[date] == ahgora[date]
      'equal'
    else
      'divergent'
    end
    { 'date' => date, 'status' => status }
  end
else
  raise ArgumentError, "Ação desconhecida: #{request['action']}"
end

puts JSON.generate(result)
